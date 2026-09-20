import { describe, expect, test } from "bun:test"
import {
  StrategyRoutingError,
  generateStrategies,
  type StrategyGenerationInput,
} from "../../src/omo/strategy"

const base: StrategyGenerationInput = {
  eligibleAgents: ["explore", "librarian", "oracle", "designer", "fixer", "observer"],
  background: { available: true, policy: "allow" },
  verification: ["none", "tests", "oracle", "observer"],
}

describe("native OMO strategy generation", () => {
  test("only emits eligible and non-disabled agents", () => {
    const strategies = generateStrategies({
      ...base,
      eligibleAgents: ["explore", "fixer", "observer"],
      disabledAgents: ["observer"],
    })

    expect(new Set(strategies.map((strategy) => strategy.agent))).toEqual(new Set(["explore", "fixer"]))
  })

  test("removes unavailable or denied background options", () => {
    expect(
      generateStrategies({ ...base, background: { available: false, policy: "allow" } }).every(
        (strategy) => !strategy.background,
      ),
    ).toBe(true)
    expect(
      generateStrategies({ ...base, background: { available: true, policy: "deny" } }).every(
        (strategy) => !strategy.background,
      ),
    ).toBe(true)
    expect(
      generateStrategies({ ...base, background: { available: true, policy: "allow" } }).some(
        (strategy) => strategy.background,
      ),
    ).toBe(true)
  })

  test("removes unavailable verification and semantically invalid pairs", () => {
    const strategies = generateStrategies({
      ...base,
      eligibleAgents: ["observer", "fixer"],
      verification: ["none", "tests"],
    })

    expect(strategies.some((strategy) => strategy.agent === "observer" && strategy.verification === "tests")).toBe(false)
    expect(strategies.every((strategy) => strategy.verification === "none" || strategy.verification === "tests")).toBe(true)
    expect(strategies.some((strategy) => strategy.agent === "fixer" && strategy.verification === "tests")).toBe(true)
  })

  test("uses stable IDs, ordering, deduplication, and a deterministic cap", () => {
    const input: StrategyGenerationInput = {
      eligibleAgents: ["fixer", "fixer", "explore", "designer", "observer", "oracle", "librarian"],
      background: { available: true, policy: "allow" },
      verification: ["none", "tests", "oracle", "observer", "none"],
    }
    const first = generateStrategies(input)
    const second = generateStrategies(input)

    expect(first).toEqual(second)
    expect(first.length).toBeLessThanOrEqual(16)
    expect(new Set(first.map((strategy) => strategy.id)).size).toBe(first.length)
    expect(first.every((strategy) => strategy.id === `${strategy.agent}:${strategy.background ? "background" : "foreground"}:${strategy.verification}`)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
  })

  test("explicit fields constrain the eligible set", () => {
    const strategies = generateStrategies({
      ...base,
      explicit: { agent: "fixer", background: true, verification: "tests" },
    })

    expect(strategies.map((strategy) => strategy.id)).toEqual(["fixer:background:tests"])
  })

  test("returns a typed error when no strategy is eligible", () => {
    expect(() =>
      generateStrategies({
        ...base,
        eligibleAgents: ["observer"],
        verification: ["tests"],
        background: { available: false, policy: "deny" },
      }),
    ).toThrow(StrategyRoutingError)

    try {
      generateStrategies({
        ...base,
        eligibleAgents: ["observer"],
        verification: ["tests"],
        background: { available: false, policy: "deny" },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: "no_eligible_strategies" })
    }
  })
})
