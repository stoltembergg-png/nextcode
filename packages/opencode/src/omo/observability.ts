import type { AgentID, OmoRoutingAlternative, RoutingSource, Verification } from "@opencode-ai/core/omo"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Ref } from "effect"

export const MAX_FAILURE_LENGTH = 160
export const MAX_ALTERNATIVES = 16
export const MAX_OVERRIDE_FIELDS = 3

export type OmoRoutingOverrides = Readonly<{
  readonly agent?: AgentID
  readonly background?: boolean
  readonly verification?: Verification
}>

export type OmoRoutingObservation = Readonly<{
  readonly agent: AgentID
  readonly background: boolean
  readonly verification: Verification
  readonly source: RoutingSource
  readonly overrides: OmoRoutingOverrides
  readonly alternatives: readonly OmoRoutingAlternative[]
  readonly fallbackReason?: string
  readonly failure?: boolean
  readonly durationMs: number
}>

export type OmoRoutingFailure = Readonly<{
  readonly reason: string
  readonly durationMs: number
}>

export interface Interface {
  readonly record: (observation: OmoRoutingObservation) => Effect.Effect<void>
  readonly last: () => Effect.Effect<OmoRoutingObservation | undefined>
  readonly lastFailure: () => Effect.Effect<OmoRoutingFailure | undefined>
  readonly clear: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OmoObservability") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const latest = yield* Ref.make<OmoRoutingObservation | undefined>(undefined)
    const failure = yield* Ref.make<OmoRoutingFailure | undefined>(undefined)

    const record = (observation: OmoRoutingObservation) =>
      Effect.gen(function* () {
        const normalized = normalizeObservation(observation)
        yield* Ref.set(latest, normalized)
        const failed = normalized.failure ?? Boolean(normalized.fallbackReason)
        if (failed && normalized.fallbackReason) {
          yield* Ref.set(failure, {
            reason: normalized.fallbackReason,
            durationMs: normalized.durationMs,
          })
          yield* Effect.logWarning("omo routing fallback", routingLogFields(normalized))
          return
        }
        yield* Effect.logDebug("omo routing decision", routingLogFields(normalized))
      })

    return Service.of({
      record,
      last: () => Ref.get(latest),
      lastFailure: () => Ref.get(failure),
      clear: () => Effect.all([Ref.set(latest, undefined), Ref.set(failure, undefined)]).pipe(Effect.asVoid),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
export const layerForTests = layer

function normalizeObservation(observation: OmoRoutingObservation): OmoRoutingObservation {
  const durationMs = finiteDuration(observation.durationMs)
  const alternatives = observation.alternatives
    .slice(0, MAX_ALTERNATIVES)
    .flatMap((alternative) => {
      const id = sanitizeIdentifier(alternative.id)
      const score = finiteScore(alternative.score)
      return id && score !== undefined ? [{ id, score }] : []
    })
  const overrides: OmoRoutingOverrides = {
    ...(typeof observation.overrides.agent === "string" ? { agent: observation.overrides.agent } : {}),
    ...(typeof observation.overrides.background === "boolean" ? { background: observation.overrides.background } : {}),
    ...(typeof observation.overrides.verification === "string"
      ? { verification: observation.overrides.verification }
      : {}),
  }

  return Object.freeze({
    agent: observation.agent,
    background: observation.background,
    verification: observation.verification,
    source: observation.source,
    overrides,
    alternatives: Object.freeze(alternatives),
    ...(observation.fallbackReason ? { fallbackReason: sanitizeReason(observation.fallbackReason) } : {}),
    ...(observation.failure === undefined ? {} : { failure: observation.failure }),
    durationMs,
  })
}

function routingLogFields(observation: OmoRoutingObservation) {
  return {
    agent: observation.agent,
    background: observation.background,
    verification: observation.verification,
    source: observation.source,
    overrides: observation.overrides,
    alternatives: observation.alternatives,
    ...(observation.fallbackReason ? { fallbackReason: observation.fallbackReason } : {}),
    ...(observation.failure === undefined ? {} : { failure: observation.failure }),
    durationMs: observation.durationMs,
  }
}

function finiteDuration(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function finiteScore(value: number) {
  return Number.isFinite(value) ? value : undefined
}

function sanitizeIdentifier(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[^a-zA-Z0-9:_-]+/g, "")
    .slice(0, 160)
}

function sanitizeReason(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(?:[a-zA-Z]:[\\/]|\/)[^\s]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FAILURE_LENGTH)
}

export * as OmoObservability from "./observability"
