import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect, Exit, Layer, Schema } from "effect"
import { Config } from "@/config/config"
import { DelegationService } from "./delegation"
import { OmoRouter } from "./router"
import { OmoRoutingActivity } from "./routing-activity"

export const name = "omo_delegate"

const MAX_RESULT_LENGTH = 12_000
const MAX_TEXT_LENGTH = 4_096
const TEST_VERIFICATION_INSTRUCTION =
  "Verification requirement: run the smallest relevant test or validation command, report the command and result, and do not claim success without evidence."

export const Input = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  evidence: Schema.String.pipe(Schema.optional),
  agent: ConfigOmo.AgentID.pipe(Schema.optional),
  background: Schema.Boolean.pipe(Schema.optional),
  verification: ConfigOmo.Verification.pipe(Schema.optional),
  task_id: Schema.String.pipe(Schema.optional),
})
export type Input = typeof Input.Type

const Alternative = Schema.Struct({
  id: Schema.String,
  score: Schema.Finite,
})

const Overrides = Schema.Struct({
  agent: ConfigOmo.AgentID.pipe(Schema.optional),
  background: Schema.Boolean.pipe(Schema.optional),
  verification: ConfigOmo.Verification.pipe(Schema.optional),
})

const FollowUp = Schema.Struct({
  required: Schema.Boolean,
  agent: ConfigOmo.AgentID,
  verification: ConfigOmo.Verification,
  prompt: Schema.String,
})

export const Output = Schema.Struct({
  child_id: Schema.String,
  job_id: Schema.String.pipe(Schema.optional),
  state: Schema.Literals(["running", "completed"]),
  result: Schema.String,
  agent: ConfigOmo.AgentID,
  background: Schema.Boolean,
  verification: ConfigOmo.Verification,
  source: Schema.Literals(["semif", "deterministic", "explicit"]),
  alternatives: Schema.Array(Alternative),
  overrides: Overrides,
  fallback_reason: Schema.String.pipe(Schema.optional),
  downgraded: Schema.String.pipe(Schema.optional),
  follow_up: FollowUp.pipe(Schema.optional),
})
export type Output = typeof Output.Type

type Runtime = {
  readonly config: Config.Interface
  readonly router: OmoRouter.Interface
  readonly delegation: DelegationService.Interface
  readonly activity: OmoRoutingActivity.Interface
}

export const tool = (runtime: Runtime) =>
  Tool.withPermission(
    Tool.make({
      description:
        "Delegate one bounded task to the native OMO specialist selected by routing. The result includes the child identity, routing provenance, and any verifier follow-up required by the selected strategy.",
      input: Input,
      output: Output,
      execute: (input, context) => execute(input, context, runtime),
      toModelOutput: ({ output }) => [{ type: "text", text: output.result }],
    }),
    name,
  )

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const config = yield* Config.Service
    const router = yield* OmoRouter.Service
    const delegation = yield* DelegationService.Service
    const activity = yield* OmoRoutingActivity.Service
    const global = yield* config.getGlobal()

    // The global configuration is the only context available while the shared
    // application carrier is built. The execute path re-checks the effective
    // instance configuration so a project-local disable/conflict cannot run a
    // native delegation even when another instance enabled the carrier.
    if (nativeOmoAvailable(global))
      yield* applications.register({ [name]: tool({ config, router, delegation, activity }) }).pipe(Effect.orDie)
  }),
)

export const node = makeGlobalNode({
  name: "omo/delegate-tool",
  layer,
  deps: [ApplicationTools.node, Config.node, OmoRouter.node, DelegationService.node, OmoRoutingActivity.node],
})

export function nativeOmoAvailable(config: {
  readonly omo?: unknown
  readonly plugin?: readonly unknown[]
  readonly plugins?: readonly unknown[]
}) {
  const resolved = ConfigOmo.resolve(config.omo).info
  const plugins = config.plugin ?? config.plugins
  return resolved.enabled && !ConfigOmo.hasLegacyPluginConflict(plugins)
}

function execute(input: Input, context: Tool.Context, runtime: Runtime) {
  const abort = new AbortController()
  const activity = runtime.activity.start({
    sessionID: context.sessionID,
    assistantMessageID: context.assistantMessageID,
    toolCallID: context.toolCallID,
  })
  return Effect.gen(function* () {
    const config = yield* runtime.config.get()
    if (!nativeOmoAvailable(config)) {
      return yield* Effect.fail(
        new Tool.Failure({ message: "Native OMO delegation is disabled or conflicts with the legacy plugin" }),
      )
    }

    const resolved = ConfigOmo.resolve(config.omo).info
    const recommendation = yield* runtime.router.route({
      summary: input.description,
      evidence: input.evidence ? [input.evidence] : undefined,
      eligibleAgents: ConfigOmo.AgentIDs,
      disabledAgents: resolved.disabled_agents,
      backgroundAvailable: true,
      backgroundPolicy: resolved.background,
      agent: input.agent,
      background: input.background,
      verification: input.verification,
      config: resolved,
      signal: abort.signal,
      activity,
    })
    yield* activity.selected(recommendation).pipe(Effect.catchCause(() => Effect.void))

    const agentConfig = resolved.agents[recommendation.agent]
    const parsedModel = agentConfig?.model ? ModelV2.parse(agentConfig.model) : undefined
    const model = parsedModel
      ? ModelV2.Ref.make({
          id: parsedModel.modelID,
          providerID: parsedModel.providerID,
          ...(agentConfig?.variant ? { variant: ModelV2.VariantID.make(agentConfig.variant) } : {}),
        })
      : undefined
    const prompt =
      recommendation.verification === "tests"
        ? `${input.prompt.slice(0, MAX_TEXT_LENGTH)}\n\n${TEST_VERIFICATION_INSTRUCTION}`
        : input.prompt
    yield* activity.delegating(recommendation).pipe(Effect.catchCause(() => Effect.void))
    const delegated = yield* runtime.delegation.delegate({
      kind: "v2",
      description: input.description,
      prompt,
      sessionID: context.sessionID,
      agent: recommendation.agent,
      task_id: input.task_id,
      background: recommendation.background,
      model,
      variant: agentConfig?.variant,
      abort: abort.signal,
    })

    const followUp =
      recommendation.verification === "oracle" || recommendation.verification === "observer"
        ? {
            required: true,
            agent: recommendation.verification,
            verification: recommendation.verification,
            prompt: `Call ${name} explicitly with agent=${recommendation.verification} and verification=${recommendation.verification} to verify child ${delegated.sessionID} before claiming completion.`,
          }
        : undefined

    return {
      child_id: String(delegated.sessionID),
      ...(delegated.jobID ? { job_id: delegated.jobID } : {}),
      state: delegated.state,
      result: boundResult(delegated.text),
      agent: recommendation.agent,
      background: delegated.background,
      verification: recommendation.verification,
      source: recommendation.source,
      alternatives: recommendation.alternatives,
      overrides: {
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.background === undefined ? {} : { background: input.background }),
        ...(input.verification === undefined ? {} : { verification: input.verification }),
      },
      ...(recommendation.fallbackReason ? { fallback_reason: boundText(recommendation.fallbackReason) } : {}),
      ...(delegated.downgraded ? { downgraded: boundText(delegated.downgraded) } : {}),
      ...(followUp ? { follow_up: followUp } : {}),
    }
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.sync(() => {
            if (!abort.signal.aborted) abort.abort(new Error("OMO delegation cancelled"))
          })
        : Effect.void,
    ),
    Effect.ensuring(activity.clear().pipe(Effect.catchCause(() => Effect.void))),
    Effect.mapError(toToolFailure),
  )
}

function boundResult(result: string) {
  return result.slice(0, MAX_RESULT_LENGTH)
}

function boundText(text: string) {
  return text.slice(0, MAX_TEXT_LENGTH)
}

function toToolFailure(error: unknown) {
  return error instanceof Tool.Failure
    ? error
    : new Tool.Failure({ message: error instanceof Error ? error.message : String(error) })
}

export * as OmoDelegateTool from "./delegate-tool"
