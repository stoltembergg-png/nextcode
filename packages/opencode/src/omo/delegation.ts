import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt as PromptV2 } from "@opencode-ai/core/session/prompt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import type { Context as ToolContext } from "@/tool/tool"
import { Effect, Exit, Context, Layer, LayerMap, Scope, Option } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

export type LegacyDelegateRequest = {
  readonly kind: "legacy"
  readonly description: string
  readonly prompt: string
  readonly subagent_type: string
  readonly task_id?: string
  readonly background?: boolean
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly agent: string
  readonly abort: AbortSignal
  readonly bypassAgentCheck?: boolean
  readonly ask: ToolContext["ask"]
  readonly metadata: ToolContext["metadata"]
  readonly promptOps?: TaskPromptOps
}

export type V2DelegateRequest = {
  readonly kind: "v2"
  readonly description: string
  readonly prompt: string
  readonly sessionID: SessionID
  readonly agent?: string
  readonly task_id?: string
  readonly background?: boolean
  readonly model?: ModelV2.Ref
  readonly variant?: string
  readonly abort: AbortSignal
  readonly metadata?: ToolContext["metadata"]
}

export type DelegateRequest = LegacyDelegateRequest | V2DelegateRequest

export type DelegateResult = {
  sessionID: SessionID
  state: "running" | "completed"
  text: string
  background: boolean
  downgraded?: string
  jobID?: string
}

export interface Interface {
  readonly delegate: (request: DelegateRequest) => Effect.Effect<DelegateResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Delegation") {}

const id = "task"
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")
const OMO_DELEGATE = "omo_delegate"
const MAX_BACKGROUND_RESULT = 12_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const delegate = Effect.fn("DelegationService.delegate")(function* (request: DelegateRequest) {
      const result = request.kind === "legacy" ? legacy(request) : v2(request)
      return yield* result.pipe(Effect.mapError(toError))
    })

    function v2(request: V2DelegateRequest) {
      return Effect.gen(function* () {
        if (request.abort.aborted) return yield* Effect.fail(new Error("Delegation cancelled"))
        const sessionsOption = yield* Effect.serviceOption(SessionV2.Service)
        const locationsOption = yield* Effect.serviceOption(LocationServiceMap.Service)
        if (Option.isNone(sessionsOption)) return yield* Effect.fail(new Error("V2 Session service is unavailable"))
        if (Option.isNone(locationsOption)) return yield* Effect.fail(new Error("V2 location services are unavailable"))
        const sessionsV2 = sessionsOption.value
        const locations = locationsOption.value

        const cfg = yield* config.get()
        const omo = ConfigOmo.resolve(cfg.omo).info
        const parent = yield* sessionsV2.get(request.sessionID)
        const depth = yield* sessionDepth(sessionsV2, parent)
        const maxDepth = cfg.subagent_depth ?? 1
        if (depth >= maxDepth) {
          return yield* Effect.fail(
            new Error(`Subagent depth limit reached (${maxDepth}). Increase "subagent_depth" to allow nested subagents.`),
          )
        }

        const requestedAgent = request.agent ? AgentV2.ID.make(request.agent) : undefined
        const taskID = request.task_id ? SessionV2.ID.make(request.task_id) : undefined
        const existing = taskID
          ? yield* sessionsV2.get(taskID).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
            )
          : undefined
        if (existing && existing.parentID !== parent.id) {
          return yield* Effect.fail(new Error(`Task ${existing.id} belongs to a different parent session`))
        }

        const agentID = requestedAgent ?? existing?.agent ?? parent.agent ?? AgentV2.ID.make("build")
        const model = modelOverride(request.model ?? existing?.model ?? parent.model, request.variant)
        yield* assertV2Delegation(locations, parent, agentID)
        const child = existing ?? (yield* sessionsV2.createChild({ parentID: parent.id, agent: agentID, model }))
        if (existing) {
          if (requestedAgent && existing.agent !== requestedAgent) yield* sessionsV2.switchAgent({ sessionID: child.id, agent: agentID })
          if (model && !sameModel(existing.model, model)) yield* sessionsV2.switchModel({ sessionID: child.id, model })
        }
        const currentChild = existing ? yield* sessionsV2.get(child.id) : child

        const metadata = {
          parentSessionId: parent.id,
          sessionId: child.id,
          agent: currentChild.agent ?? agentID,
          ...(currentChild.model ? { model: currentChild.model } : {}),
        }
        if (request.metadata) yield* request.metadata({ title: request.description, metadata })

        yield* sessionsV2.prompt({
          sessionID: child.id,
          prompt: PromptV2.make({ text: request.prompt }),
          resume: false,
        })

        const runChild = Effect.fn("DelegationService.runV2Child")(function* () {
          yield* sessionsV2.resume(child.id)
          return yield* readV2Result(sessionsV2, child.id)
        })
        const runInBackground = request.background === true && omo.background !== "deny"
        if (!runInBackground) {
          const text = yield* runForeground(runChild(), request.abort, sessionsV2.interrupt(child.id))
          return {
            sessionID: child.id,
            state: "completed" as const,
            text: renderV2Output(child.id, "completed", text),
            background: false,
            ...(request.background === true ? { downgraded: "background disabled by OMO policy" } : {}),
          }
        }

        const job = yield* startV2Background({
          parent,
          child,
          sessionsV2,
          description: request.description,
          run: runChild().pipe(
            Effect.raceFirst(abortSignal(request.abort)),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? sessionsV2.interrupt(child.id) : Effect.void)),
            Effect.provideService(SessionV2.Service, sessionsV2),
          ),
          metadata,
          notify: request.metadata,
        }).pipe(
          Effect.catch((error) => {
            if (omo.background === "deny" || request.abort.aborted) return Effect.fail(error)
            return Effect.succeed(undefined)
          }),
        )
        if (job) {
          return {
            sessionID: child.id,
            state: "running" as const,
            text: renderV2Output(child.id, "running", BACKGROUND_STARTED),
            background: true,
            jobID: job.id,
          }
        }

        const text = yield* runForeground(runChild(), request.abort, sessionsV2.interrupt(child.id))
        return {
          sessionID: child.id,
          state: "completed" as const,
          text: renderV2Output(child.id, "completed", text),
          background: false,
          downgraded: "native background service unavailable",
        }
      })
    }

    const sessionDepth = Effect.fn("DelegationService.sessionDepth")(function* (
      sessionsV2: SessionV2.Interface,
      session: SessionV2.Info,
    ) {
      let current = session
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessionsV2.get(current.parentID)
      }
      return depth
    })

    const assertV2Delegation = Effect.fn("DelegationService.assertV2Delegation")(function* (
      locations: LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>,
      parent: SessionV2.Info,
      agentID: AgentV2.ID,
    ) {
      yield* Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        const permissions = yield* PermissionV2.Service
        const agent = yield* agents.get(agentID)
        if (!agent) return yield* Effect.fail(new Error(`Unknown agent type: ${agentID} is not a valid agent type`))
        yield* permissions.assert({
          sessionID: parent.id,
          agent: parent.agent,
          action: OMO_DELEGATE,
          resources: [agentID],
        })
      }).pipe(Effect.provide(locations.get(parent.location)))
    })

    const startV2Background = Effect.fn("DelegationService.startV2Background")(function* (input: {
      parent: SessionV2.Info
      child: SessionV2.Info
      sessionsV2: SessionV2.Interface
      description: string
      run: Effect.Effect<string, unknown>
      metadata: Record<string, unknown>
      notify?: ToolContext["metadata"]
    }) {
      const extend = yield* background.extend({ id: input.child.id, run: input.run })
      if (extend) {
        const current = yield* background.get(input.child.id)
        if (current) return current
        return yield* Effect.fail(new Error(`Background task ${input.child.id} disappeared while extending`))
      }

      const started = yield* background.start({
        id: input.child.id,
        type: "omo_delegate",
        title: input.description,
        metadata: { ...input.metadata, background: true },
        run: input.run,
      })
      if (input.notify) {
        yield* input.notify({
          title: input.description,
          metadata: { ...input.metadata, background: true, jobId: started.id },
        })
      }
      yield* notifyV2Background(input.sessionsV2, input.parent.id, input.child.id, input.description, started.id)
      return started
    })

    const notifyV2Background = Effect.fn("DelegationService.notifyV2Background")(function* (
      sessionsV2: SessionV2.Interface,
      parentID: SessionID,
      childID: SessionID,
      description: string,
      jobID: string,
    ) {
      yield* background.wait({ id: jobID }).pipe(
        Effect.flatMap((result) => {
          const info = result.info
          if (!info) return Effect.void
          if (info.status === "completed") return injectV2Result(sessionsV2, parentID, childID, description, "completed", info.output ?? "")
          if (info.status === "error") return injectV2Result(sessionsV2, parentID, childID, description, "error", info.error ?? "")
          if (info.status === "cancelled") return injectV2Result(sessionsV2, parentID, childID, description, "error", "Task cancelled")
          return Effect.void
        }),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    const injectV2Result = Effect.fn("DelegationService.injectV2Result")(function* (
      sessionsV2: SessionV2.Interface,
      parentID: SessionID,
      childID: SessionID,
      description: string,
      state: "completed" | "error",
      text: string,
    ) {
      yield* sessionsV2.prompt({
        sessionID: parentID,
        prompt: PromptV2.make({
          text: renderV2Output(
            childID,
            state,
            state === "completed" ? `Background task completed: ${description}\n${text}` : `Background task failed: ${description}\n${text}`,
          ),
        }),
      }).pipe(Effect.ignore)
    })

    function legacy(request: LegacyDelegateRequest) {
      return Effect.gen(function* () {
        const runInBackground = request.background === true
        if (runInBackground && !flags.experimentalBackgroundSubagents) {
          return yield* Effect.fail(
            new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
          )
        }

        const cfg = yield* config.get()
        const parent = yield* sessions.get(request.sessionID)
        let current = parent
        let depth = 0
        while (current.parentID) {
          depth++
          current = yield* sessions.get(current.parentID)
        }
        if (depth >= (cfg.subagent_depth ?? 1)) {
          return yield* Effect.fail(
            new Error(
              `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
            ),
          )
        }

        if (!request.bypassAgentCheck) {
          yield* request.ask({
            permission: id,
            patterns: [request.subagent_type],
            always: ["*"],
            metadata: {
              description: request.description,
              subagent_type: request.subagent_type,
            },
          })
        }

        const next = yield* agent.get(request.subagent_type)
        if (!next) {
          return yield* Effect.fail(
            new Error(`Unknown agent type: ${request.subagent_type} is not a valid agent type`),
          )
        }

        const session = request.task_id
          ? yield* sessions.get(SessionID.make(request.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
        const childPermission = deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent: next,
        })
        const childToolDenies = [
          ...(next.permission.some((rule) => rule.permission === "todowrite")
            ? []
            : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
          ...(next.permission.some((rule) => rule.permission === id)
            ? []
            : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
          ...(cfg.experimental?.primary_tools?.map((permission) => ({
            permission,
            pattern: "*" as const,
            action: "deny" as const,
          })) ?? []),
        ]
        const nextSession =
          session ??
          (yield* sessions.create({
            parentID: request.sessionID,
            title: request.description + ` (@${next.name} subagent)`,
            agent: next.name,
            permission: [
              ...childPermission,
              ...childToolDenies.filter(
                (deny) =>
                  !childPermission.some(
                    (rule) =>
                      rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                  ),
              ),
            ],
          }))

        const msg = yield* MessageV2.get({ sessionID: request.sessionID, messageID: request.messageID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.orDie,
        )
        if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
        const variant = msg.info.variant

        const model = next.model ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }
        const metadata = {
          parentSessionId: request.sessionID,
          sessionId: nextSession.id,
          model,
          ...(runInBackground ? { background: true } : {}),
        }

        yield* request.metadata({
          title: request.description,
          metadata,
        })

        const ops = request.promptOps
        if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

        const runTask = Effect.fn("DelegationService.runLegacyTask")(function* () {
          const parts = yield* ops.resolvePromptParts(request.prompt)
          const result = yield* ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            variant: next.model ? undefined : variant,
            agent: next.name,
            parts,
          })
          if (result.info.role === "assistant" && result.info.error) {
            const message =
              "message" in result.info.error.data && typeof result.info.error.data.message === "string"
                ? result.info.error.data.message
                : result.info.error.name
            return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
          }
          const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
          if (failed?.type === "tool" && failed.state.status === "error") {
            return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
          }
          return result.parts.findLast((item) => item.type === "text")?.text ?? ""
        })

        const inject = Effect.fn("DelegationService.injectBackgroundResult")(function* (
          state: "completed" | "error",
          text: string,
        ) {
          const currentParent = yield* sessions.get(request.sessionID)
          yield* ops
            .prompt({
              sessionID: request.sessionID,
              agent: currentParent.agent ?? request.agent,
              variant,
              parts: [
                {
                  type: "text",
                  synthetic: true,
                  text: renderOutput({
                    sessionID: nextSession.id,
                    state,
                    summary:
                      state === "completed"
                        ? `Background task completed: ${request.description}`
                        : `Background task failed: ${request.description}`,
                    text,
                  }),
                },
              ],
            })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        })

        const notify = Effect.fn("DelegationService.notifyBackgroundResult")(function* (jobID: string) {
          yield* background.wait({ id: jobID }).pipe(
            Effect.flatMap((result) => {
              if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
              if (result.info?.status === "error") return inject("error", result.info.error ?? "")
              return Effect.void
            }),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        })

        if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
          return {
            sessionID: nextSession.id,
            state: "running" as const,
            text: renderOutput({
              sessionID: nextSession.id,
              state: "running",
              summary: "Background task updated",
              text: BACKGROUND_UPDATED,
            }),
            background: true,
            jobID: nextSession.id,
          }
        }

        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: request.description,
          metadata,
          onPromote: Effect.all([
            request.metadata({
              title: request.description,
              metadata: { ...metadata, background: true, jobId: nextSession.id },
            }),
            notify(nextSession.id),
          ]),
          run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
        })

        const backgroundResult = () => ({
          sessionID: nextSession.id,
          state: "running" as const,
          text: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
          background: true,
          jobID: info.id,
        })

        if (runInBackground) {
          yield* notify(info.id)
          return backgroundResult()
        }

        const runCancel = yield* EffectBridge.make()
        const cancel = ops.cancel(nextSession.id)

        const onAbort = () => {
          runCancel.fork(cancel)
        }

        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            request.abort.addEventListener("abort", onAbort)
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.raceFirst(
                background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
                background.waitForPromotion(nextSession.id),
              )
              if (result?.metadata?.background === true) return backgroundResult()
              if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
              if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
              return {
                sessionID: nextSession.id,
                state: "completed" as const,
                text: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
                background: false,
              }
            }),
          (_, exit) =>
            Effect.gen(function* () {
              if (Exit.hasInterrupts(exit)) {
                yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
              }
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  request.abort.removeEventListener("abort", onAbort)
                }),
              ),
            ),
        )
      })
    }

    return Service.of({ delegate })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Agent.node,
    BackgroundJob.node,
    Config.node,
    Database.node,
    RuntimeFlags.node,
    Session.node,
  ],
})

export const layerForTests = layer

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function modelOverride(model: ModelV2.Ref | undefined, variant: string | undefined) {
  if (!model || variant === undefined) return model
  return { ...model, variant: ModelV2.VariantID.make(variant) }
}

function sameModel(left: ModelV2.Ref | undefined, right: ModelV2.Ref | undefined) {
  return (
    left?.providerID === right?.providerID &&
    left?.id === right?.id &&
    (left?.variant ?? "default") === (right?.variant ?? "default")
  )
}

function abortSignal(signal: AbortSignal) {
  return Effect.callback<never>((resume) => {
    const onAbort = () => resume(Effect.interrupt)
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

function runForeground<E, R>(
  run: Effect.Effect<string, E, R>,
  abort: AbortSignal,
  interrupt: Effect.Effect<void, never, R>,
): Effect.Effect<string, E | Error, R> {
  return run.pipe(
    Effect.raceFirst(abortSignal(abort)),
    Effect.catchCause((cause): Effect.Effect<never, E | Error> =>
      abort.aborted ? Effect.fail(new Error("Delegation cancelled")) : Effect.failCause(cause),
    ),
    Effect.ensuring(
      Effect.sync(() => abort.aborted).pipe(Effect.flatMap((cancelled) => (cancelled ? interrupt : Effect.void))),
    ),
  )
}

function renderV2Output(sessionID: SessionID, state: "running" | "completed" | "error", text: string) {
  const bounded = text.length > MAX_BACKGROUND_RESULT ? `${text.slice(0, MAX_BACKGROUND_RESULT)}\n[output truncated]` : text
  const tag = state === "error" ? "task_error" : "task_result"
  return [`<task id="${sessionID}" state="${state}">`, `<${tag}>`, bounded, `</${tag}>`, "</task>"].join("\n")
}

function readV2Result(service: SessionV2.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    const messages = yield* service.messages({ sessionID, order: "desc", limit: 64 })
    const assistant = messages.find((message): message is SessionMessage.Assistant => message.type === "assistant")
    if (!assistant) return ""
    if (assistant.error) return yield* Effect.fail(new Error(assistant.error.message))
    const toolError = assistant.content.find(
      (part): part is SessionMessage.AssistantTool => part.type === "tool" && part.state.status === "error",
    )
    if (toolError?.state.status === "error") return yield* Effect.fail(new Error(toolError.state.error.message))
    return assistant.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
  })
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export * as DelegationService from "./delegation"
