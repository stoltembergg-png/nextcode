export * as Omo from "./omo"

import { Schema } from "effect"

export const AgentIDs = ["orchestrator", "explore", "librarian", "oracle", "designer", "fixer", "observer"] as const
export const AgentID = Schema.Literals(AgentIDs).annotate({ identifier: "OmoAgentID" })
export type AgentID = typeof AgentID.Type

export const Verification = Schema.Literals(["none", "tests", "oracle", "observer"]).annotate({
  identifier: "OmoVerification",
})
export type Verification = typeof Verification.Type

export const RoutingSource = Schema.Literals(["semif", "deterministic", "explicit"]).annotate({
  identifier: "OmoRoutingSource",
})
export type RoutingSource = typeof RoutingSource.Type
