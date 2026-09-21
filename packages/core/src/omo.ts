import { Schema } from "effect"
import { RoutingSource } from "@opencode-ai/schema/omo"
import { ConfigOmo } from "./config/omo"
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

export { RoutingSource } from "@opencode-ai/schema/omo"

import PROMPT_DESIGNER from "./omo/designer.txt"
import PROMPT_EXPLORE from "./omo/explore.txt"
import PROMPT_FIXER from "./omo/fixer.txt"
import PROMPT_LIBRARIAN from "./omo/librarian.txt"
import PROMPT_OBSERVER from "./omo/observer.txt"
import PROMPT_ORACLE from "./omo/oracle.txt"
import PROMPT_ORCHESTRATOR from "./omo/orchestrator.txt"

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

export type OmoAgentPermissionEffect = "allow" | "ask" | "deny"

export interface OmoAgentPermission {
  readonly action: string
  readonly resource: string
  readonly effect: OmoAgentPermissionEffect
}

export interface OmoAgentDefinition {
  readonly id: AgentID
  readonly description: string
  readonly prompt: string
  readonly mode: "primary" | "subagent"
  readonly permissions: readonly OmoAgentPermission[]
  readonly permissionOverrides?: readonly OmoAgentPermission[]
  readonly model?: string
  readonly variant?: string
}

const readOnlyPermissions: readonly OmoAgentPermission[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "list", resource: "*", effect: "allow" },
  { action: "lsp", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
]

const researchPermissions: readonly OmoAgentPermission[] = [
  ...readOnlyPermissions,
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
]

const implementationPermissions: readonly OmoAgentPermission[] = [
  ...readOnlyPermissions,
  { action: "edit", resource: "*", effect: "allow" },
  { action: "bash", resource: "*", effect: "allow" },
]

const definitions: Readonly<Record<AgentID, Omit<OmoAgentDefinition, "model" | "variant" | "permissions"> & {
  readonly permissions: readonly OmoAgentPermission[]
}>> = {
  orchestrator: {
    id: "orchestrator",
    description: "Workflow manager that delegates coding work to specialists and verifies the reconciled result.",
    prompt: PROMPT_ORCHESTRATOR,
    mode: "primary",
    permissions: [
      { action: "question", resource: "*", effect: "allow" },
      { action: "plan_enter", resource: "*", effect: "allow" },
      { action: "plan_exit", resource: "*", effect: "allow" },
      { action: "omo_delegate", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "task", resource: "*", effect: "allow" },
    ],
  },
  explore: {
    id: "explore",
    description:
      'Fast agent specialized for exploring codebases. Use this when you need to find files, search code, or answer focused repository questions without changing files.',
    prompt: PROMPT_EXPLORE,
    mode: "subagent",
    permissions: researchPermissions,
  },
  librarian: {
    id: "librarian",
    description: "External documentation and dependency research backed by authoritative sources and evidence.",
    prompt: PROMPT_LIBRARIAN,
    mode: "subagent",
    permissions: researchPermissions,
  },
  oracle: {
    id: "oracle",
    description: "Read-only technical advisor for architecture, diagnosis, risk, simplification, and code review.",
    prompt: PROMPT_ORACLE,
    mode: "subagent",
    permissions: readOnlyPermissions,
  },
  designer: {
    id: "designer",
    description: "UI/UX design, review, and implementation with attention to responsive visual and interaction quality.",
    prompt: PROMPT_DESIGNER,
    mode: "subagent",
    permissions: implementationPermissions,
  },
  fixer: {
    id: "fixer",
    description: "Focused implementation specialist for bounded code changes and assigned validation.",
    prompt: PROMPT_FIXER,
    mode: "subagent",
    permissions: implementationPermissions,
  },
  observer: {
    id: "observer",
    description: "Read-only visual and media analyst for images, screenshots, PDFs, and diagrams.",
    prompt: PROMPT_OBSERVER,
    mode: "subagent",
    permissions: readOnlyPermissions,
  },
}

export function agentDefinition(id: AgentID): OmoAgentDefinition {
  return definitions[id]
}

export function agentDefinitions(resolved: ConfigOmo.Resolved): readonly OmoAgentDefinition[] {
  if (!resolved.enabled) return []

  return AgentIDs.flatMap((id) => {
    const agent = resolved.agents[id]
    if (!agent) return []
    const definition = agentDefinition(id)
    const permissionOverrides = permissionRules(agent.permission)
    return [
      {
        ...definition,
        ...(permissionOverrides.length ? { permissionOverrides } : {}),
        ...(agent.model === undefined ? {} : { model: agent.model }),
        ...(agent.variant === undefined ? {} : { variant: agent.variant }),
      },
    ]
  })
}

function permissionRules(input: Readonly<Record<string, unknown>> | undefined): readonly OmoAgentPermission[] {
  if (!input) return []
  return Object.entries(input).flatMap(([action, value]) => {
    const direct = permissionEffect(value)
    if (direct) return [{ action, resource: "*", effect: direct }]
    if (!isRecord(value)) return []
    return Object.entries(value).flatMap(([resource, effect]) => {
      const result = permissionEffect(effect)
      return result ? [{ action, resource, effect: result }] : []
    })
  })
}

function permissionEffect(input: unknown): OmoAgentPermissionEffect | undefined {
  return input === "allow" || input === "ask" || input === "deny" ? input : undefined
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
