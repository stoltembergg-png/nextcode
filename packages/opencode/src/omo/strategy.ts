import { AgentIDs, type AgentID, type Background, type Verification } from "@opencode-ai/core/omo"

export type StrategyBackground = {
  readonly available: boolean
  readonly policy: Background
}

export type StrategyOverrides = {
  readonly agent?: AgentID
  readonly background?: boolean
  readonly verification?: Verification
}

export type StrategyGenerationInput = {
  readonly eligibleAgents: readonly AgentID[]
  readonly disabledAgents?: readonly AgentID[]
  readonly background: StrategyBackground
  readonly verification: readonly Verification[]
  readonly explicit?: StrategyOverrides
}

export type StrategyExecutionMode = "foreground" | "background"

export type OmoStrategy = Readonly<{
  readonly id: string
  readonly agent: AgentID
  readonly background: boolean
  readonly verification: Verification
  readonly mode: StrategyExecutionMode
  readonly priority: number
}>

export class StrategyRoutingError extends Error {
  readonly code = "no_eligible_strategies" as const

  constructor(message = "No eligible OMO strategy is available") {
    super(message)
    this.name = "StrategyRoutingError"
  }
}

export const MAX_STRATEGIES = 16

const verificationOrder: readonly Verification[] = ["none", "tests", "oracle", "observer"]
const agentOrder = new Map(AgentIDs.map((agent, index) => [agent, index]))

export function generateStrategies(input: StrategyGenerationInput): readonly OmoStrategy[] {
  const disabled = new Set(input.disabledAgents ?? [])
  const agents = AgentIDs.filter((agent) => input.eligibleAgents.includes(agent) && !disabled.has(agent))
  const verifications = verificationOrder.filter((verification) => input.verification.includes(verification))
  const backgrounds = allowedBackgrounds(input.background, input.explicit?.background)
  const candidates = agents.flatMap((agent) =>
    backgrounds.flatMap((background) =>
      verifications.flatMap((verification) => {
        if (!isCompatible(agent, verification)) return []
        if (input.explicit?.agent !== undefined && input.explicit.agent !== agent) return []
        if (input.explicit?.verification !== undefined && input.explicit.verification !== verification) return []
        return [makeStrategy(agent, background, verification)]
      }),
    ),
  )

  const ranked = candidates
    .toSorted((left, right) => left.priority - right.priority || compareIDs(left.id, right.id))
    .filter((strategy, index, values) => index === values.findIndex((candidate) => candidate.id === strategy.id))
  const strategies = boundedWithCoverage(ranked)
    .map((strategy) => Object.freeze(strategy))

  if (strategies.length === 0) throw new StrategyRoutingError()
  return Object.freeze(strategies)
}

export const generateStrategyOptions = generateStrategies

export function strategyId(agent: AgentID, background: boolean, verification: Verification) {
  return `${agent}:${background ? "background" : "foreground"}:${verification}`
}

function allowedBackgrounds(background: StrategyBackground, explicit: boolean | undefined) {
  if (explicit !== undefined) return explicit && background.available && background.policy !== "deny" ? [true] : explicit ? [] : [false]
  if (!background.available || background.policy === "deny") return [false]
  return [false, true]
}

function makeStrategy(agent: AgentID, background: boolean, verification: Verification): OmoStrategy {
  const mode = background ? "background" : "foreground"
  return {
    id: strategyId(agent, background, verification),
    agent,
    background,
    verification,
    mode,
    priority: strategyPriority(agent, background, verification),
  }
}

function strategyPriority(agent: AgentID, background: boolean, verification: Verification) {
  const agentIndex = agentOrder.get(agent) ?? AgentIDs.length
  const modePriority = background ? 100 : 0
  const verificationIndex = verificationOrder.indexOf(verification)
  if (!background && preferredVerification(agent) !== "none" && verification === preferredVerification(agent)) return 20 + agentIndex
  return modePriority + (verification === "none" ? 0 : 200 + verificationIndex * 10) + agentIndex
}

function preferredVerification(agent: AgentID): Verification {
  if (agent === "oracle") return "oracle"
  if (agent === "observer") return "observer"
  if (agent === "designer" || agent === "fixer") return "tests"
  return "none"
}

function boundedWithCoverage(ranked: readonly OmoStrategy[]) {
  if (ranked.length <= MAX_STRATEGIES) return ranked
  const selected: OmoStrategy[] = []
  const selectedIDs = new Set<string>()
  const addFirstMissing = (read: (strategy: OmoStrategy) => string) => {
    const seen = new Set<string>()
    for (const strategy of ranked) {
      const value = read(strategy)
      if (seen.has(value) || selectedIDs.has(strategy.id)) continue
      seen.add(value)
      selected.push(strategy)
      selectedIDs.add(strategy.id)
    }
  }

  addFirstMissing((strategy) => strategy.agent)
  addFirstMissing((strategy) => strategy.verification)
  addFirstMissing((strategy) => String(strategy.background))
  for (const strategy of ranked) {
    if (selected.length >= MAX_STRATEGIES) break
    if (selectedIDs.has(strategy.id)) continue
    selected.push(strategy)
    selectedIDs.add(strategy.id)
  }
  return selected.toSorted((left, right) => left.priority - right.priority || compareIDs(left.id, right.id)).slice(0, MAX_STRATEGIES)
}

function compareIDs(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isCompatible(agent: AgentID, verification: Verification) {
  if (agent === "observer") return verification === "none" || verification === "observer"
  if ((agent === "explore" || agent === "librarian" || agent === "oracle") && verification === "tests") return false
  return true
}

export * as OmoStrategy from "./strategy"
