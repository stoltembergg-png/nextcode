export * as OmoRoutingActivity from "./routing-activity"

import type { OmoRoutingRecommendation } from "@opencode-ai/core/omo"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { OmoRoutingEvent } from "@opencode-ai/schema/omo-routing-event"
import { Context, Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"

export type Identity = Readonly<{
  sessionID: SessionSchema.ID
  assistantMessageID: SessionMessage.ID
  toolCallID: string
  startedAt?: number
}>

export type Delegating = Pick<OmoRoutingRecommendation, "agent" | "background" | "source">

export interface Tracker {
  readonly analyzing: () => Effect.Effect<void>
  readonly selected: (recommendation: OmoRoutingRecommendation) => Effect.Effect<void>
  readonly delegating: (recommendation: Delegating) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
}

export interface Interface {
  readonly start: (identity: Identity) => Tracker
}

export type Publish = (activity: OmoRoutingEvent.OmoRoutingActivity) => Effect.Effect<unknown, unknown>

export class Service extends Context.Service<Service, Interface>()("@opencode/OmoRoutingActivity") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return Service.of({
      start: (identity) => makeTracker((activity) => events.publish(OmoRoutingEvent.Updated, activity), identity),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node] })

export function makeTracker(publish: Publish, identity: Identity): Tracker {
  const startedAt = timestamp(identity.startedAt)
  let phase: OmoRoutingEvent.OmoRoutingActivity["state"]["phase"] | "initial" = "initial"
  let sequence = 0

  const transition = (
    allowed: readonly (OmoRoutingEvent.OmoRoutingActivity["state"]["phase"] | "initial")[],
    next: (updatedAt: number) => OmoRoutingEvent.OmoRoutingActivity["state"],
  ) =>
    Effect.suspend(() => {
      if (!allowed.includes(phase)) return Effect.void
      const updatedAt = timestamp()
      const state = next(updatedAt)
      phase = state.phase
      const activity = {
        sessionID: identity.sessionID,
        assistantMessageID: identity.assistantMessageID,
        toolCallID: identity.toolCallID,
        sequence,
        startedAt,
        updatedAt,
        state,
      } satisfies OmoRoutingEvent.OmoRoutingActivity
      sequence += 1
      return publish(activity).pipe(Effect.catchCause(() => Effect.void), Effect.asVoid)
    })

  return {
    analyzing: () => transition(["initial"], () => ({ phase: "analyzing" })),
    selected: (recommendation) => {
      const fallback = fallbackCode(recommendation.fallbackReason)
      return transition(["initial", "analyzing"], (updatedAt) => ({
        phase: "selected",
        agent: recommendation.agent,
        source: recommendation.source,
        background: recommendation.background,
        verification: recommendation.verification,
        durationMs: Math.max(0, updatedAt - startedAt),
        ...(fallback ? { fallback } : {}),
      }))
    },
    delegating: (recommendation) =>
      transition(["selected"], () => ({
        phase: "delegating",
        agent: recommendation.agent,
        source: recommendation.source,
        background: recommendation.background,
      })),
    clear: () => transition(["initial", "analyzing", "selected", "delegating"], () => ({ phase: "cleared" })),
  }
}

export function fallbackCode(reason: string | undefined): OmoRoutingEvent.FallbackCode | undefined {
  if (!reason) return
  const value = reason.toLowerCase()
  if (value.includes("timed out")) return "timeout"
  if (value.includes("ineligible")) return "ineligible_response"
  if (value.includes("incomplete") || value.includes("missing")) return "incomplete_response"
  if (value.includes("malformed")) return "invalid_response"
  if (value.includes("policy")) return "policy"
  if (value.includes("single eligible")) return "single_strategy"
  return "unavailable"
}

function timestamp(value = Date.now()) {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}
