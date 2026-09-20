import { Schema } from "effect"
import {
  AgentID,
  AgentIDs,
  Background,
  DEFAULT_BACKGROUND,
  DEFAULT_PRESET,
  DEFAULT_ROUTING,
  DEFAULT_VERIFICATION,
  LEGACY_PLUGIN,
  Preset,
  PresetAgents,
  Routing,
  Verification,
} from "./config/omo"

export {
  AgentID,
  AgentIDs,
  Background,
  DEFAULT_BACKGROUND,
  DEFAULT_PRESET,
  DEFAULT_ROUTING,
  DEFAULT_VERIFICATION,
  LEGACY_PLUGIN,
  Preset,
  PresetAgents,
  Routing,
  Verification,
}

export const RoutingSource = Schema.Literals(["semif", "deterministic", "explicit"]).annotate({
  identifier: "OmoRoutingSource",
})
export type RoutingSource = typeof RoutingSource.Type

export const OmoRoutingRequest = Schema.Struct({
  summary: Schema.String,
  evidence: Schema.Array(Schema.String).pipe(Schema.optional),
  agent: AgentID.pipe(Schema.optional),
  background: Schema.Boolean.pipe(Schema.optional),
  verification: Verification.pipe(Schema.optional),
}).annotate({ identifier: "OmoRoutingRequest" })
export type OmoRoutingRequest = typeof OmoRoutingRequest.Type

export const OmoRoutingAlternative = Schema.Struct({
  id: Schema.String,
  score: Schema.Finite,
}).annotate({ identifier: "OmoRoutingAlternative" })
export type OmoRoutingAlternative = typeof OmoRoutingAlternative.Type

export const OmoRoutingRecommendation = Schema.Struct({
  agent: AgentID,
  background: Schema.Boolean,
  verification: Verification,
  source: RoutingSource,
  alternatives: Schema.Array(OmoRoutingAlternative),
  fallbackReason: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "OmoRoutingRecommendation" })
export type OmoRoutingRecommendation = typeof OmoRoutingRecommendation.Type

export const RoutingRequest = OmoRoutingRequest
export const RoutingRecommendation = OmoRoutingRecommendation
