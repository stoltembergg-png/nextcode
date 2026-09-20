import type { AgentID, Verification } from "@opencode-ai/core/omo"
import {
  StrategyRoutingError,
  type OmoStrategy,
  type StrategyOverrides,
} from "./strategy"

export type DeterministicRoutingInput = {
  readonly summary: string
  readonly evidence?: readonly string[]
  readonly strategies: readonly OmoStrategy[]
  readonly backgroundPreference?: boolean
  readonly independent?: boolean
  readonly explicit?: StrategyOverrides
  readonly fallbackReason?: string
}

export type DeterministicAlternative = Readonly<{
  readonly id: string
  readonly score: number
}>

export type DeterministicRoutingResult = Readonly<{
  readonly id: string
  readonly strategy: OmoStrategy
  readonly agent: AgentID
  readonly background: boolean
  readonly verification: Verification
  readonly source: "deterministic"
  readonly alternatives: readonly DeterministicAlternative[]
  readonly fallbackReason: string
}>

const MAX_SIGNAL_LENGTH = 512
const MAX_EVIDENCE_ITEMS = 16
const MAX_REASON_LENGTH = 160

const signals: Readonly<Record<AgentID, readonly string[]>> = {
  orchestrator: ["orchestrate", "orchestration", "coordinate", "workflow", "delegat"],
  explore: ["repository", "repo", "codebase", "discover", "explore", "inspect", "find", "search", "file", "files", "structure", "map", "arquiv", "estrutura", "mape"],
  librarian: ["documentation", "document", "docs", "dependency", "dependencies", "package", "library", "research", "reference", "official", "npm", "api", "documenta", "dependencia", "biblioteca", "pesquis"],
  oracle: ["architecture", "architect", "diagnos", "review", "audit", "tradeoff", "design", "reason", "cause", "risk", "arquitetura", "diagnost", "revis", "analise", "analis"],
  designer: ["visual", "ui", "ux", "frontend", "interface", "layout", "style", "styling", "css", "component", "screen", "design", "visual", "tela", "estilo"],
  fixer: ["implement", "implementation", "fix", "bug", "change", "code", "coding", "test", "tests", "refactor", "patch", "edit", "write", "corrig", "implementar", "alterar", "codigo", "teste"],
  observer: ["image", "images", "screenshot", "pdf", "diagram", "media", "picture", "evidence", "visual", "imagem", "figura", "captura", "evidencia"],
}

const verificationSignals: Readonly<Record<Exclude<Verification, "none">, readonly string[]>> = {
  tests: ["test", "tests", "testing", "spec", "suite", "coverage", "teste", "testes", "cobertura"],
  oracle: ["architecture", "architect", "diagnos", "review", "audit", "tradeoff", "risk", "arquitetura", "diagnost", "revis", "analise", "analis"],
  observer: ["image", "images", "screenshot", "pdf", "diagram", "media", "picture", "visual", "evidence", "imagem", "figura", "captura", "evidencia"],
}

const independentSignals = ["independent", "independently", "parallel", "background", "async", "asynchronous", "standalone", "long-running", "monitor", "deferred", "paralelo", "independente"]
const foregroundSignals = ["current", "session", "interactive", "foreground", "immediate", "quick", "now", "atual", "sessao", "interativo", "agora"]

export function routeDeterministic(input: DeterministicRoutingInput): DeterministicRoutingResult {
  const eligible = input.strategies.filter((strategy) => matchesOverrides(strategy, input.explicit))
  if (eligible.length === 0) throw new StrategyRoutingError()

  const words = tokenize([input.summary, ...(input.evidence ?? []).slice(0, MAX_EVIDENCE_ITEMS)].join(" "))
  const independent = input.independent ?? hasAny(words, independentSignals)
  const ranked = eligible
    .map((strategy, index) => ({ strategy, index, score: scoreStrategy(strategy, words, independent, input.backgroundPreference) }))
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
  const selected = ranked[0]
  if (!selected) throw new StrategyRoutingError()

  const alternatives = ranked.map((item) => Object.freeze({ id: item.strategy.id, score: finiteScore(item.score) }))
  return Object.freeze({
    id: selected.strategy.id,
    strategy: selected.strategy,
    agent: selected.strategy.agent,
    background: selected.strategy.background,
    verification: selected.strategy.verification,
    source: "deterministic",
    alternatives: Object.freeze(alternatives),
    fallbackReason: sanitizeReason(input.fallbackReason ?? "deterministic task-signal routing"),
  })
}

export const deterministicRoute = routeDeterministic

function matchesOverrides(strategy: OmoStrategy, explicit: StrategyOverrides | undefined) {
  if (!explicit) return true
  if (explicit.agent !== undefined && explicit.agent !== strategy.agent) return false
  if (explicit.background !== undefined && explicit.background !== strategy.background) return false
  if (explicit.verification !== undefined && explicit.verification !== strategy.verification) return false
  return true
}

function scoreStrategy(
  strategy: OmoStrategy,
  words: ReadonlySet<string>,
  independent: boolean,
  backgroundPreference: boolean | undefined,
) {
  let score = 0
  score += agentScore(strategy.agent, words)
  score += verificationScore(strategy.verification, words)
  score += executionScore(strategy.background, words, independent, backgroundPreference)
  return finiteScore(score)
}

function agentScore(agent: AgentID, words: ReadonlySet<string>) {
  const matches = signals[agent].filter((signal) => hasSignal(words, signal)).length
  if (matches === 0) return 0
  const visualBoost = agent === "observer" && hasAny(words, verificationSignals.observer) ? 16 : 0
  return matches * 100 + visualBoost
}

function verificationScore(verification: Verification, words: ReadonlySet<string>) {
  if (verification === "none") return hasAny(words, verificationSignals.tests) || hasAny(words, verificationSignals.oracle) || hasAny(words, verificationSignals.observer) ? 0 : 8
  return hasAny(words, verificationSignals[verification]) ? 36 : 0
}

function executionScore(
  background: boolean,
  words: ReadonlySet<string>,
  independent: boolean,
  backgroundPreference: boolean | undefined,
) {
  const prefersForeground = hasAny(words, foregroundSignals)
  if (background && independent && !prefersForeground && backgroundPreference !== false) return 24
  if (!background && (prefersForeground || backgroundPreference === false || !independent)) return 12
  return 0
}

function tokenize(input: string) {
  const bounded = input.slice(0, MAX_SIGNAL_LENGTH * (MAX_EVIDENCE_ITEMS + 1))
  const normalized = bounded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean).slice(0, MAX_SIGNAL_LENGTH))
}

function hasAny(words: ReadonlySet<string>, candidates: readonly string[]) {
  return candidates.some((candidate) => hasSignal(words, candidate))
}

function hasSignal(words: ReadonlySet<string>, candidate: string) {
  if (candidate.length < 4) return words.has(candidate)
  return [...words].some((word) => word === candidate || word.startsWith(candidate))
}

function finiteScore(value: number) {
  return Number.isFinite(value) ? value : 0
}

function sanitizeReason(input: string) {
  return input
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(?:[a-zA-Z]:[\\/]|\/)[^\s]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH)
}

export * as OmoDeterministic from "./deterministic"
