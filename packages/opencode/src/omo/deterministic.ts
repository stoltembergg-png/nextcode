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

const MAX_SUMMARY_LENGTH = 512
const MAX_EVIDENCE_LENGTH = 512
const MAX_EVIDENCE_ITEMS = 16
const MAX_SIGNAL_TEXT_LENGTH = MAX_SUMMARY_LENGTH + MAX_EVIDENCE_ITEMS * (MAX_EVIDENCE_LENGTH + 1)
const MAX_SIGNAL_TOKENS = 512
const MAX_REASON_LENGTH = 160

type SemanticSignalGroup = {
  readonly key: string
  readonly terms: readonly string[]
  readonly weight: number
}

const semanticSignals: Readonly<Record<AgentID, readonly SemanticSignalGroup[]>> = {
  orchestrator: [
    { key: "coordination", terms: ["orchestrate", "orchestration", "coordinate", "workflow", "delegate", "delegates", "delegation"], weight: 120 },
  ],
  explore: [
    { key: "repository", terms: ["repository", "repo", "codebase", "structure", "arquivo", "arquivos", "estrutura", "mapear", "mapeamento"], weight: 120 },
    { key: "discovery", terms: ["discover", "explore", "inspect", "find", "search", "file", "files", "map"], weight: 100 },
  ],
  librarian: [
    { key: "research", terms: ["research", "reference", "official", "npm", "api", "documentacao", "documentar", "biblioteca", "pesquisa", "pesquisar"], weight: 130 },
    { key: "documentation", terms: ["documentation", "document", "docs"], weight: 110 },
    { key: "dependency", terms: ["dependency", "dependencies", "package", "library", "dependencia"], weight: 120 },
  ],
  oracle: [
    { key: "architecture", terms: ["architecture", "architect", "arquitetura"], weight: 140 },
    { key: "diagnosis", terms: ["diagnosis", "diagnose", "diagnostic", "reason", "cause", "risk", "diagnostico", "diagnosticar", "analise", "analisar"], weight: 120 },
    { key: "review", terms: ["review", "audit", "tradeoff", "tradeoffs", "revisao", "revisar"], weight: 100 },
  ],
  designer: [
    { key: "ui", terms: ["ui", "ux", "frontend", "interface", "layout", "css", "component", "screen", "tela"], weight: 180 },
    { key: "visual-design", terms: ["visual", "style", "styling", "design", "estilo"], weight: 120 },
    { key: "implementation", terms: ["implement", "implementation", "implementing", "implementar"], weight: 40 },
  ],
  fixer: [
    { key: "implementation", terms: ["implement", "implementation", "implementing", "implementar", "code", "coding", "patch", "edit", "write", "change", "refactor", "alterar", "codigo"], weight: 130 },
    { key: "defect", terms: ["fix", "bug", "error", "failure", "corrigir", "correcao"], weight: 120 },
    { key: "testing", terms: ["test", "tests", "testing", "spec", "suite", "coverage", "teste", "testes", "cobertura"], weight: 60 },
  ],
  observer: [
    { key: "visual-evidence", terms: ["image", "images", "screenshot", "pdf", "diagram", "media", "picture", "evidence", "imagem", "figura", "captura", "evidencia"], weight: 220 },
  ],
}

const verificationSignals: Readonly<Record<Exclude<Verification, "none">, readonly string[]>> = {
  tests: ["test", "tests", "testing", "spec", "suite", "coverage", "teste", "testes", "cobertura"],
  oracle: ["architecture", "architect", "diagnosis", "diagnose", "diagnostic", "review", "audit", "tradeoff", "tradeoffs", "risk", "arquitetura", "diagnostico", "diagnosticar", "revisao", "revisar", "analise", "analisar"],
  observer: ["image", "images", "screenshot", "pdf", "diagram", "media", "picture", "visual", "evidence", "imagem", "figura", "captura", "evidencia"],
}

const independentSignals = ["independent", "independently", "parallel", "background", "async", "asynchronous", "standalone", "long-running", "monitor", "deferred", "paralelo", "independente"]
const foregroundSignals = ["current", "session", "interactive", "foreground", "immediate", "quick", "now", "atual", "sessao", "interativo", "agora"]

export function routeDeterministic(input: DeterministicRoutingInput): DeterministicRoutingResult {
  const eligible = input.strategies.filter((strategy) => matchesOverrides(strategy, input.explicit))
  if (eligible.length === 0) throw new StrategyRoutingError()

  const words = tokenize(
    [
      input.summary.slice(0, MAX_SUMMARY_LENGTH),
      ...(input.evidence ?? []).slice(0, MAX_EVIDENCE_ITEMS).map((item) => item.slice(0, MAX_EVIDENCE_LENGTH)),
    ].join(" "),
  )
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
  return scoreSemanticSignals(semanticSignals[agent], words)
}

function scoreSemanticSignals(groups: readonly SemanticSignalGroup[], words: ReadonlySet<string>) {
  const counted = new Set<string>()
  return groups.reduce((score, group) => {
    if (counted.has(group.key) || !hasAny(words, group.terms)) return score
    counted.add(group.key)
    return score + group.weight
  }, 0)
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
  const bounded = input.slice(0, MAX_SIGNAL_TEXT_LENGTH)
  const normalized = bounded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean).slice(0, MAX_SIGNAL_TOKENS))
}

function hasAny(words: ReadonlySet<string>, candidates: readonly string[]) {
  return candidates.some((candidate) => hasSignal(words, candidate))
}

function hasSignal(words: ReadonlySet<string>, candidate: string) {
  return words.has(candidate)
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
