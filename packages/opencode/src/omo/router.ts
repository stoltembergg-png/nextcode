import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  AgentID,
  Background,
  OmoRoutingAlternative,
  OmoRoutingRecommendation,
  Routing,
  Verification,
} from "@opencode-ai/core/omo"
import { Option, Cause, Context, Effect, Exit, Layer } from "effect"
import { Config } from "@/config/config"
import { SemifWarmup } from "@/semif/warmup"
import { SemifService, type Status } from "@/semif/service"
import type { SemifDecision, SemifDecisionRequest } from "@/semif/scoring"
import { OmoObservability } from "./observability"
import type { OmoRoutingActivity } from "./routing-activity"
import { routeDeterministic, type DeterministicRoutingResult } from "./deterministic"
import {
  generateStrategies,
  StrategyRoutingError,
  type OmoStrategy,
  type StrategyBackground,
  type StrategyOverrides,
} from "./strategy"

export const DEFAULT_TIMEOUT_MS = 750
export const MAX_SUMMARY_LENGTH = 512
export const MAX_EVIDENCE_ITEMS = 16
export const MAX_EVIDENCE_LENGTH = 512
export const MAX_OPTION_DESCRIPTION_LENGTH = 160

export type OmoRoutingConfig = Readonly<{
  readonly enabled?: boolean
  readonly routing?: Routing
  readonly background?: Background
  readonly verification?: Verification
  readonly agents?: Readonly<Record<string, unknown>>
  readonly disabled_agents?: readonly AgentID[]
}>

export type OmoRoutingRequest = Readonly<{
  readonly summary: string
  readonly evidence?: readonly string[]
  readonly eligibleAgents?: readonly AgentID[]
  readonly disabledAgents?: readonly AgentID[]
  readonly background?: boolean | StrategyBackground
  readonly backgroundAvailable?: boolean
  readonly backgroundPolicy?: Background
  readonly verification?: Verification | readonly Verification[]
  readonly availableVerification?: readonly Verification[]
  readonly verificationModes?: readonly Verification[]
  readonly agent?: AgentID
  readonly explicit?: StrategyOverrides
  readonly config?: OmoRoutingConfig
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly activity?: OmoRoutingActivity.Tracker
}>

export class OmoRoutingCancelled extends Error {
  readonly code = "omo_routing_cancelled" as const

  constructor(reason = "OMO routing cancelled") {
    super(reason)
    this.name = "OmoRoutingCancelled"
  }
}

export interface Interface {
  readonly route: (request: OmoRoutingRequest) => Effect.Effect<OmoRoutingRecommendation, OmoRoutingCancelled | StrategyRoutingError>
  readonly recommend: Interface["route"]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OmoRouter") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const semif = yield* SemifService.Service
    const observability = yield* OmoObservability.Service
    const config = yield* Config.Service
    const scope = yield* Effect.scope

    const route = (request: OmoRoutingRequest) => {
      const started = performance.now()
      const work = routeInternal(request, started, { semif, observability, config, scope })
      if (!request.signal) return work
      if (request.signal.aborted) return Effect.fail(new OmoRoutingCancelled(abortReason(request.signal)))
      return work.pipe(
        Effect.raceFirst(
          waitForAbort(request.signal).pipe(
            Effect.mapError((error) => new OmoRoutingCancelled(error.message)),
          ),
        ),
      )
    }

    return Service.of({ route, recommend: route })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SemifService.node, OmoObservability.node, Config.node],
})

export const layerForTests = layer

type Runtime = {
  readonly semif: SemifService.Interface
  readonly observability: OmoObservability.Interface
  readonly config: Config.Interface
  readonly scope: import("effect/Scope").Scope
}

function routeInternal(
  request: OmoRoutingRequest,
  started: number,
  runtime: Runtime,
): Effect.Effect<OmoRoutingRecommendation, StrategyRoutingError> {
  return Effect.gen(function* () {
    const resolved = yield* resolveConfig(request, runtime.config)
    const explicit = readExplicit(request)
    const strategies = yield* makeStrategies(request, resolved, explicit)
    const summary = boundSummary(request.summary)
    const evidence = boundEvidence(request.evidence)
    const route = resolved.routing ?? "auto"
    const fallback = (reason: string, failure = true) =>
      fallbackRecommendation({
        summary,
        evidence,
        strategies,
        explicit,
        reason,
        started,
        observability: runtime.observability,
        failure,
      })

    if (strategies.length < 2) return yield* fallback("single eligible strategy", false)
    if (route === "deterministic") return yield* fallback("deterministic routing policy", false)

    const statusExit = yield* runtime.semif.status().pipe(Effect.exit)
    if (Exit.isFailure(statusExit)) {
      return yield* fallback(`semif status unavailable: ${causeMessage(statusExit.cause)}`)
    }

    const status = statusExit.value
    if (status.status !== "ready") {
      yield* warmup(status, runtime.semif, runtime.scope)
      return yield* fallback(`semif is ${status.status}`)
    }

    if (request.activity) yield* request.activity.analyzing().pipe(Effect.catchCause(() => Effect.void))
    const decisionExit = yield* decideWithTimeout(
      runtime.semif,
      makeDecisionRequest(summary, evidence, strategies, request.signal),
      request.timeoutMs,
    ).pipe(Effect.exit)
    if (Exit.isFailure(decisionExit)) {
      return yield* fallback(`semif decision failed: ${causeMessage(decisionExit.cause)}`)
    }

    const normalized = normalizeDecision(decisionExit.value, strategies)
    if (normalized._tag === "Failure") return yield* fallback(normalized.reason)

    const recommendation = recommendationFromSemif(normalized, explicit)
    yield* record(runtime.observability, recommendation, explicit, started)
    return recommendation
  })
}

function resolveConfig(request: OmoRoutingRequest, config: Config.Interface | undefined) {
  return Effect.gen(function* () {
    if (request.config) return request.config
    return ConfigOmo.resolve(config ? (yield* config.get()).omo : undefined).info
  })
}

function makeStrategies(request: OmoRoutingRequest, resolved: OmoRoutingConfig, explicit: StrategyOverrides) {
  return Effect.try({
    try: () =>
      generateStrategies({
        eligibleAgents: request.eligibleAgents ?? defaultEligibleAgents(resolved),
        disabledAgents: [...(resolved.disabled_agents ?? []), ...(request.disabledAgents ?? [])],
        background: readBackground(request, resolved),
        verification: readVerification(request, resolved),
        explicit,
      }),
    catch: (cause) => (cause instanceof StrategyRoutingError ? cause : new StrategyRoutingError(String(cause))),
  })
}

function defaultEligibleAgents(config: OmoRoutingConfig): readonly AgentID[] {
  if (!config.agents) return ConfigOmo.AgentIDs
  return ConfigOmo.AgentIDs.filter((id) => Object.hasOwn(config.agents!, id))
}

function readBackground(request: OmoRoutingRequest, config: OmoRoutingConfig): StrategyBackground {
  if (typeof request.background === "object") return request.background
  return {
    available: request.backgroundAvailable ?? true,
    policy: request.backgroundPolicy ?? config.background ?? "auto",
  }
}

function readVerification(request: OmoRoutingRequest, config: OmoRoutingConfig): readonly Verification[] {
  const available = request.availableVerification ??
    request.verificationModes ??
    (Array.isArray(request.verification) ? request.verification : ["none", "tests", "oracle", "observer"])
  if (typeof request.verification === "string") return [request.verification]
  if (config.verification && config.verification !== "none" && available.includes(config.verification)) {
    return [config.verification]
  }
  return available
}

function readExplicit(request: OmoRoutingRequest): StrategyOverrides {
  const input = {
    ...request.explicit,
    ...(request.agent === undefined ? {} : { agent: request.agent }),
    ...(typeof request.background === "boolean" ? { background: request.background } : {}),
    ...(typeof request.verification === "string" ? { verification: request.verification } : {}),
  }
  return Object.freeze(input)
}

function makeDecisionRequest(
  summary: string,
  evidence: readonly string[],
  strategies: readonly OmoStrategy[],
  signal?: AbortSignal,
): SemifDecisionRequest {
  return {
    state: { summary, evidence },
    question: "Choose the single eligible OMO strategy that best fits the task.",
    options: strategies.map((strategy) => ({
      id: strategy.id,
      description: optionDescription(strategy),
    })),
    ...(signal ? { signal } : {}),
  }
}

function optionDescription(strategy: OmoStrategy) {
  return `agent=${strategy.agent}; mode=${strategy.mode}; verification=${strategy.verification}`.slice(
    0,
    MAX_OPTION_DESCRIPTION_LENGTH,
  )
}

function decideWithTimeout(
  service: SemifService.Interface,
  request: SemifDecisionRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.trunc(timeoutMs)) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const unlink = linkAbortSignal(request.signal, controller)
  const timeoutMessage = `semif decision timed out after ${duration}ms`
  return service
    .decide({ ...request, signal: controller.signal })
    .pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () => Effect.sync(() => controller.abort(new Error(timeoutMessage))).pipe(Effect.andThen(Effect.fail(new Error(timeoutMessage)))),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          unlink()
          if (!controller.signal.aborted) controller.abort(new Error("semif decision interrupted"))
        }),
      ),
    )
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController) {
  if (!source) return () => undefined
  const abort = () => target.abort(source.reason)
  if (source.aborted) {
    abort()
    return () => undefined
  }
  source.addEventListener("abort", abort, { once: true })
  return () => source.removeEventListener("abort", abort)
}

function normalizeDecision(
  decision: SemifDecision,
  strategies: readonly OmoStrategy[],
):
  | { readonly _tag: "Success"; readonly strategy: OmoStrategy; readonly alternatives: readonly OmoRoutingAlternative[] }
  | { readonly _tag: "Failure"; readonly reason: string } {
  if (!isCompleteDecision(decision)) return { _tag: "Failure", reason: "semif returned malformed output" }
  if (decision.option_ids.length !== strategies.length || decision.probabilities.length !== strategies.length) {
    return { _tag: "Failure", reason: "semif returned an incomplete option score list" }
  }
  const eligible = new Map(strategies.map((strategy) => [strategy.id, strategy]))
  const seen = new Set<string>()
  const alternatives = decision.option_ids.flatMap((id, index) => {
    if (typeof id !== "string" || seen.has(id) || !eligible.has(id)) return []
    seen.add(id)
    const score = decision.probabilities[index]
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0) return []
    return [{ id, score }]
  })
  if (alternatives.length !== strategies.length || seen.size !== strategies.length) {
    return { _tag: "Failure", reason: "semif returned an ineligible option" }
  }
  if (Array.isArray(decision.missing_slots) && decision.missing_slots.length > 0) {
    return { _tag: "Failure", reason: "semif returned missing answer slots" }
  }
  if (typeof decision.chosen !== "string" || !eligible.has(decision.chosen)) {
    return { _tag: "Failure", reason: "semif returned an ineligible choice" }
  }
  const selected = eligible.get(decision.chosen)
  if (!selected) return { _tag: "Failure", reason: "semif returned an ineligible choice" }
  return {
    _tag: "Success",
    strategy: selected,
    alternatives: Object.freeze(
      alternatives.toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id)),
    ),
  }
}

function recommendationFromSemif(
  normalized: Extract<ReturnType<typeof normalizeDecision>, { readonly _tag: "Success" }>,
  explicit: StrategyOverrides,
): OmoRoutingRecommendation {
  return Object.freeze({
    agent: normalized.strategy.agent,
    background: normalized.strategy.background,
    verification: normalized.strategy.verification,
    source: hasOverrides(explicit) ? "explicit" : "semif",
    alternatives: normalized.alternatives,
  })
}

function fallbackRecommendation(input: {
  readonly summary: string
  readonly evidence: readonly string[]
  readonly strategies: readonly OmoStrategy[]
  readonly explicit: StrategyOverrides
  readonly reason: string
  readonly started: number
  readonly observability: OmoObservability.Interface
  readonly failure?: boolean
}) {
  const deterministic = routeDeterministic({
    summary: input.summary,
    evidence: input.evidence,
    strategies: input.strategies,
    explicit: input.explicit,
    fallbackReason: input.reason,
  })
  const recommendation = toRecommendation(deterministic, input.explicit)
  return input.observability
    .record({
      agent: recommendation.agent,
      background: recommendation.background,
      verification: recommendation.verification,
      source: recommendation.source,
      overrides: input.explicit,
      alternatives: recommendation.alternatives,
      fallbackReason: recommendation.fallbackReason,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
      durationMs: elapsed(input.started),
    })
    .pipe(Effect.ignore, Effect.as(recommendation))
}

function toRecommendation(result: DeterministicRoutingResult, explicit: StrategyOverrides): OmoRoutingRecommendation {
  return Object.freeze({
    agent: result.agent,
    background: result.background,
    verification: result.verification,
    source: hasOverrides(explicit) ? "explicit" : "deterministic",
    alternatives: result.alternatives,
    fallbackReason: result.fallbackReason,
  })
}

function hasOverrides(overrides: StrategyOverrides) {
  return overrides.agent !== undefined || overrides.background !== undefined || overrides.verification !== undefined
}

function record(
  observability: OmoObservability.Interface,
  recommendation: OmoRoutingRecommendation,
  overrides: StrategyOverrides,
  started: number,
) {
  return observability.record({
    agent: recommendation.agent,
    background: recommendation.background,
    verification: recommendation.verification,
    source: recommendation.source,
    overrides,
    alternatives: recommendation.alternatives,
    ...(recommendation.fallbackReason ? { fallbackReason: recommendation.fallbackReason } : {}),
    durationMs: elapsed(started),
  })
}

function warmup(status: Status, service: SemifService.Interface, scope: import("effect/Scope").Scope) {
  if (!SemifWarmup.shouldPrepare(status)) return Effect.void
  return service.start().pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
}

function boundSummary(summary: string) {
  return summary.slice(0, MAX_SUMMARY_LENGTH)
}

function boundEvidence(evidence: readonly string[] | undefined) {
  return (evidence ?? []).slice(0, MAX_EVIDENCE_ITEMS).map((item) => item.slice(0, MAX_EVIDENCE_LENGTH))
}

function elapsed(started: number) {
  const value = performance.now() - started
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function waitForAbort(signal: AbortSignal) {
  return Effect.callback<never, Error>((resume) => {
    const onAbort = () => resume(Effect.fail(new Error(abortReason(signal))))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason.message : "user cancelled OMO routing"
}

function causeMessage(cause: Cause.Cause<unknown>) {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (failure instanceof Error) return failure.message
  if (typeof failure === "string") return failure
  return "unknown SemIf failure"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCompleteDecision(value: unknown): value is SemifDecision {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== "string" ||
    !isStringArray(value.option_ids) ||
    !isNumberArray(value.probabilities) ||
    !isNumberArray(value.option_logits) ||
    !isNumberArray(value.answer_token_ids) ||
    typeof value.chosen !== "string" ||
    !Number.isFinite(value.input_tokens) ||
    typeof value.prompt_sha256 !== "string" ||
    typeof value.prompt_version !== "string" ||
    !isRecord(value.model) ||
    typeof value.model.source !== "string" ||
    typeof value.model.revision !== "string" ||
    typeof value.model.server !== "string" ||
    typeof value.probability_status !== "string" ||
    typeof value.readout !== "string" ||
    !Number.isFinite(value.forward_seconds) ||
    !Number.isFinite(value.total_seconds) ||
    !isStringArray(value.missing_slots) ||
    (value.cached !== undefined && typeof value.cached !== "boolean")
  ) {
    return false
  }
  return value.option_logits.length === value.option_ids.length && value.answer_token_ids.length === value.option_ids.length
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number")
}

export * as OmoRouter from "./router"
