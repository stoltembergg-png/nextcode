export * as OmoRoutingEvent from "./omo-routing-event"

import { Schema } from "effect"
import { Event } from "./event"
import { Omo } from "./omo"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const FallbackCode = Schema.Literals([
  "unavailable",
  "timeout",
  "invalid_response",
  "ineligible_response",
  "incomplete_response",
  "policy",
  "single_strategy",
])
export type FallbackCode = typeof FallbackCode.Type

export const State = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("analyzing") }),
  Schema.Struct({
    phase: Schema.Literal("selected"),
    agent: Omo.AgentID,
    source: Omo.RoutingSource,
    background: Schema.Boolean,
    verification: Omo.Verification,
    durationMs: NonNegativeInt,
    fallback: FallbackCode.pipe(Schema.optional),
  }),
  Schema.Struct({
    phase: Schema.Literal("delegating"),
    agent: Omo.AgentID,
    source: Omo.RoutingSource,
    background: Schema.Boolean,
  }),
  Schema.Struct({ phase: Schema.Literal("cleared") }),
])

export const Updated = Event.define({
  type: "session.omo.routing",
  schema: {
    sessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
    toolCallID: Schema.String,
    sequence: NonNegativeInt,
    startedAt: NonNegativeInt,
    updatedAt: NonNegativeInt,
    state: State,
  },
})
export type OmoRoutingActivity = typeof Updated.data.Type
export const Definitions = Event.inventory(Updated)
