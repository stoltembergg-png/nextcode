import { LayerNode } from "@opencode-ai/core/effect/layer-node"
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
import { Effect, Exit, Context, Layer, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"

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

/** Reserved for the V2 adapter. Task 8 adds its concrete request contract. */
export type V2DelegateRequest = {
  readonly kind: "v2"
  readonly [key: string]: unknown
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
      if (request.kind === "legacy") return yield* legacy(request)
      return yield* Effect.fail(new Error("V2 delegation is not available yet"))
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
  deps: [Agent.node, BackgroundJob.node, Config.node, Database.node, RuntimeFlags.node, Session.node],
})

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

export * as DelegationService from "./delegation"
