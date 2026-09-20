export * as ConfigOmo from "./omo"

import { Schema } from "effect"
import { ModelV2 } from "../model"

export const AgentIDs = ["orchestrator", "explore", "librarian", "oracle", "designer", "fixer", "observer"] as const
export const AgentID = Schema.Literals(AgentIDs).annotate({
  identifier: "OmoAgentID",
  description: "Stable native OMO agent identifier",
})
export type AgentID = typeof AgentID.Type

export const Preset = Schema.Literals(["auto", "openai", "opencode-go"]).annotate({
  identifier: "OmoPreset",
  description: "Approved native OMO model preset",
})
export type Preset = typeof Preset.Type

export const Background = Schema.Literals(["auto", "allow", "deny"]).annotate({
  identifier: "OmoBackgroundPolicy",
  description: "Native OMO background delegation policy",
})
export type Background = typeof Background.Type

export const Routing = Schema.Literals(["auto", "deterministic", "semif"]).annotate({
  identifier: "OmoRoutingPolicy",
  description: "Native OMO routing policy",
})
export type Routing = typeof Routing.Type

export const Verification = Schema.Literals(["none", "tests", "oracle", "observer"]).annotate({
  identifier: "OmoVerification",
  description: "Native OMO verification default",
})
export type Verification = typeof Verification.Type

export const Agent = Schema.Struct({
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  permission: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}).annotate({
  identifier: "OmoAgentConfig",
  description: "Per-agent native OMO model and permission overrides",
})
export type Agent = typeof Agent.Type

export class Info extends Schema.Class<Info>("Config.Omo")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable native OMO behavior; omitted enables the native default",
  }),
  preset: Preset.pipe(Schema.optional),
  agents: Schema.Record(Schema.String, Agent).pipe(Schema.optional),
  disabled_agents: Schema.Array(Schema.String).pipe(Schema.optional),
  background: Background.pipe(Schema.optional),
  routing: Routing.pipe(Schema.optional),
  verification: Verification.pipe(Schema.optional),
}) {}
export type Input = typeof Info.Type

export interface ResolvedAgent {
  readonly model?: string
  readonly variant?: string
  readonly permission?: Readonly<Record<string, unknown>>
}

export interface Resolved {
  readonly enabled: boolean
  readonly preset: Preset
  readonly agents: Readonly<Record<string, ResolvedAgent | undefined>>
  readonly disabled_agents: readonly AgentID[]
  readonly background: Background
  readonly routing: Routing
  readonly verification: Verification
}

export interface Diagnostic {
  readonly kind: "invalid"
  readonly path: readonly string[]
  readonly message: string
}

export interface ResolveResult {
  readonly info: Resolved
  readonly diagnostics: readonly Diagnostic[]
}

export const DEFAULT_PRESET: Preset = "auto"
export const DEFAULT_BACKGROUND: Background = "auto"
export const DEFAULT_ROUTING: Routing = "auto"
export const DEFAULT_VERIFICATION: Verification = "none"
export const LEGACY_PLUGIN = "oh-my-opencode-slim"
export const RawInput: unique symbol = Symbol("ConfigOmo.RawInput")

const presetAgents: Readonly<Record<Preset, Readonly<Partial<Record<AgentID, ResolvedAgent>>>>> = {
  auto: {},
  openai: {
    orchestrator: { model: "openai/gpt-5.6-terra", variant: "high" },
    oracle: { model: "openai/gpt-5.6-sol", variant: "high" },
    librarian: { model: "openai/gpt-5.6-luna", variant: "low" },
    explore: { model: "openai/gpt-5.6-luna", variant: "low" },
    designer: { model: "openai/gpt-5.6-luna", variant: "medium" },
    fixer: { model: "openai/gpt-5.6-luna", variant: "high" },
  },
  "opencode-go": {
    orchestrator: { model: "opencode-go/minimax-m3", variant: "thinking" },
    oracle: { model: "opencode-go/qwen3.7-max", variant: "max" },
    librarian: { model: "opencode-go/deepseek-v4-flash", variant: "high" },
    explore: { model: "opencode-go/deepseek-v4-flash", variant: "high" },
    designer: { model: "opencode-go/kimi-k2.7-code" },
    fixer: { model: "opencode-go/deepseek-v4-flash", variant: "high" },
    observer: { model: "opencode-go/mimo-v2.5" },
  },
}

export const PresetAgents = presetAgents

export function attachRawInput<T extends object>(target: T, input: unknown) {
  Object.defineProperty(target, RawInput, {
    configurable: true,
    value: input,
  })
  return target
}

export function rawInput(input: unknown) {
  if (typeof input !== "object" || input === null) return undefined
  return (input as { [RawInput]?: unknown })[RawInput]
}

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const maxDiagnostics = 32

export function resolve(input: unknown): ResolveResult {
  const diagnostics: Diagnostic[] = []
  const raw = record(input)
  const enabled = optionalBoolean(raw, "enabled", true, ["enabled"], diagnostics)
  const preset = optionalLiteral(raw, "preset", Preset, DEFAULT_PRESET, ["preset"], diagnostics)
  const background = optionalLiteral(raw, "background", Background, DEFAULT_BACKGROUND, ["background"], diagnostics)
  const routing = optionalLiteral(raw, "routing", Routing, DEFAULT_ROUTING, ["routing"], diagnostics)
  const verification = optionalLiteral(
    raw,
    "verification",
    Verification,
    DEFAULT_VERIFICATION,
    ["verification"],
    diagnostics,
  )
  const agents = readAgents(raw, preset, diagnostics)
  const disabled = readDisabledAgents(raw, enabled, diagnostics)
  const observerOptIn = observerIsExplicit(raw)
  const activeIDs = AgentIDs.filter((id) => {
    if (id === "observer" && !observerOptIn) return false
    return !disabled.includes(id)
  })
  const resolvedAgents = enabled
    ? Object.fromEntries(
        activeIDs.map((id) => [
          id,
          {
            ...(presetAgents[preset][id] ?? {}),
            ...(agents[id] ?? {}),
          },
        ]),
      )
    : {}

  return {
    info: {
      enabled,
      preset,
      agents: resolvedAgents as Readonly<Record<string, ResolvedAgent | undefined>>,
      disabled_agents: disabled,
      background,
      routing,
      verification,
    },
    diagnostics,
  }
}

export interface DefaultAgentInput {
  readonly omo?: unknown
  readonly default_agent?: unknown
  readonly plugins?: readonly unknown[]
}

export interface DefaultAgentResult {
  readonly id: string
  readonly native: boolean
  readonly conflict: boolean
}

export function resolveDefaultAgent(input: DefaultAgentInput): DefaultAgentResult {
  const conflict = hasLegacyPluginConflict(input.plugins)
  const configured = typeof input.default_agent === "string" && input.default_agent.trim()
  if (configured) return { id: configured, native: false, conflict }
  const enabled = resolve(input.omo).info.enabled
  if (enabled && !conflict) return { id: "orchestrator", native: true, conflict: false }
  return { id: "build", native: false, conflict }
}

export function defaultAgent(input: DefaultAgentInput) {
  return resolveDefaultAgent(input).id
}

export function hasLegacyPluginConflict(plugins: readonly unknown[] | undefined) {
  return plugins?.some((plugin) => isLegacyPluginEntry(plugin)) ?? false
}

function readAgents(raw: Record<string, unknown>, preset: Preset, diagnostics: Diagnostic[]) {
  if (!Object.hasOwn(raw, "agents")) return {}
  const value = raw.agents
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, ["agents"], "agents must be an object")
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) => {
      if (!isAgentID(name)) {
        addDiagnostic(diagnostics, ["agents", name], "unknown OMO agent")
        return []
      }
      if (!isRecord(item)) {
        addDiagnostic(diagnostics, ["agents", name], "agent override must be an object")
        return []
      }
      const path = ["agents", name]
      const model = optionalModel(item, "model", [...path, "model"], diagnostics)
      const variant = optionalString(item, "variant", [...path, "variant"], diagnostics)
      const permission = optionalPermission(item, "permission", [...path, "permission"], diagnostics)
      return [[name, { ...(model === undefined ? {} : { model }), ...(variant === undefined ? {} : { variant }), ...(permission === undefined ? {} : { permission }) }]]
    }),
  ) as Readonly<Partial<Record<AgentID, ResolvedAgent>>>
}

function readDisabledAgents(raw: Record<string, unknown>, enabled: boolean, diagnostics: Diagnostic[]) {
  if (!Object.hasOwn(raw, "disabled_agents")) return [] as AgentID[]
  if (!Array.isArray(raw.disabled_agents)) {
    addDiagnostic(diagnostics, ["disabled_agents"], "disabled_agents must be an array")
    return [] as AgentID[]
  }
  return raw.disabled_agents.flatMap((item, index) => {
    if (typeof item !== "string" || !isAgentID(item)) {
      addDiagnostic(
        diagnostics,
        ["disabled_agents", typeof item === "string" ? item : String(index)],
        item === "orchestrator" && enabled
          ? "orchestrator cannot be disabled while OMO is enabled"
          : typeof item === "string"
            ? "unknown OMO agent"
            : "disabled agent must be a string",
      )
      return []
    }
    if (item === "orchestrator" && enabled) {
      addDiagnostic(diagnostics, ["disabled_agents", item], "orchestrator cannot be disabled while OMO is enabled")
      return []
    }
    return [item]
  })
}

function observerIsExplicit(raw: Record<string, unknown>) {
  const agents = isRecord(raw.agents) ? raw.agents : undefined
  return (
    (Array.isArray(raw.disabled_agents) && raw.disabled_agents.length === 0) ||
    (agents !== undefined && Object.hasOwn(agents, "observer"))
  )
}

function optionalBoolean(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
  path: string[],
  diagnostics: Diagnostic[],
) {
  if (!Object.hasOwn(raw, key)) return fallback
  if (typeof raw[key] === "boolean") return raw[key]
  addDiagnostic(diagnostics, path, `${key} must be a boolean`)
  return fallback
}

function optionalLiteral<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  schema: Schema.Decoder<T>,
  fallback: T,
  path: string[],
  diagnostics: Diagnostic[],
) {
  if (!Object.hasOwn(raw, key)) return fallback
  const value = Schema.decodeUnknownOption(schema, decodeOptions)(raw[key])
  if (value._tag === "Some") return value.value
  addDiagnostic(diagnostics, path, `${key} has an unsupported value`)
  return fallback
}

function optionalModel(raw: Record<string, unknown>, key: string, path: string[], diagnostics: Diagnostic[]) {
  if (!Object.hasOwn(raw, key)) return undefined
  if (typeof raw[key] !== "string") {
    addDiagnostic(diagnostics, path, "model must use provider/model syntax")
    return undefined
  }
  const value = raw[key].trim()
  if (!value.includes("/")) {
    addDiagnostic(diagnostics, path, "model must use provider/model syntax")
    return undefined
  }
  const parsed = ModelV2.parse(value)
  if (!String(parsed.providerID) || !String(parsed.modelID)) {
    addDiagnostic(diagnostics, path, "model must use provider/model syntax")
    return undefined
  }
  return value
}

function optionalString(raw: Record<string, unknown>, key: string, path: string[], diagnostics: Diagnostic[]) {
  if (!Object.hasOwn(raw, key)) return undefined
  if (typeof raw[key] === "string" && raw[key].trim()) return raw[key].trim()
  addDiagnostic(diagnostics, path, `${key} must be a non-empty string`)
  return undefined
}

function optionalPermission(raw: Record<string, unknown>, key: string, path: string[], diagnostics: Diagnostic[]) {
  if (!Object.hasOwn(raw, key)) return undefined
  if (isRecord(raw[key])) return { ...raw[key] }
  addDiagnostic(diagnostics, path, "permission must be an object")
  return undefined
}

function isLegacyPluginEntry(input: unknown) {
  if (typeof input === "string") return isLegacyPackage(input)
  if (Array.isArray(input)) return typeof input[0] === "string" && isLegacyPackage(input[0])
  return isRecord(input) && typeof input.package === "string" && isLegacyPackage(input.package)
}

function isLegacyPackage(input: string) {
  if (input === LEGACY_PLUGIN) return true
  if (!input.startsWith(`${LEGACY_PLUGIN}@`)) return false
  const version = input.slice(LEGACY_PLUGIN.length + 1)
  return version.length > 0 && !version.includes("/") && !version.includes("\\") && !version.includes(":")
}

function isAgentID(input: string): input is AgentID {
  return (AgentIDs as readonly string[]).includes(input)
}

function record(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function addDiagnostic(diagnostics: Diagnostic[], path: readonly string[], message: string) {
  if (diagnostics.length >= maxDiagnostics) return
  diagnostics.push({ kind: "invalid", path: path.map((item) => item.slice(0, 64)), message: message.slice(0, 160) })
}
