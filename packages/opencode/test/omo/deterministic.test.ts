import { describe, expect, test } from "bun:test"
import { routeDeterministic } from "../../src/omo/deterministic"
import { generateStrategies, type StrategyGenerationInput } from "../../src/omo/strategy"

const strategyInput: StrategyGenerationInput = {
  eligibleAgents: ["explore", "librarian", "oracle", "designer", "fixer", "observer"],
  background: { available: true, policy: "allow" },
  verification: ["none", "tests", "oracle", "observer"],
}

const strategies = generateStrategies(strategyInput)

const cases = [
  ["repository discovery", "Explore the repository structure and find the relevant files", "explore"],
  ["external research", "Research the dependency API and read the official documentation", "librarian"],
  ["architecture review", "Diagnose the architecture and review the design tradeoffs", "oracle"],
  ["visual implementation", "Implement the UI layout and improve the visual design", "designer"],
  ["bounded change", "Fix the bug and add a focused test for the code change", "fixer"],
  ["visual evidence", "Inspect the screenshot and PDF image evidence", "observer"],
] as const

describe("deterministic OMO routing", () => {
  test.each(cases)("routes %s to the expected specialist", (_name, summary, agent) => {
    const result = routeDeterministic({ summary, strategies })

    expect(result.strategy.agent).toBe(agent)
    expect(result.id).toBe(result.strategy.id)
    expect(result.source).toBe("deterministic")
  })

  test("classifies UI implementation as design work and plain implementation as code work", () => {
    expect(routeDeterministic({ summary: "UI implementation for the settings screen", strategies }).agent).toBe("designer")
    expect(routeDeterministic({ summary: "implementation of the bounded parser change", strategies }).agent).toBe("fixer")
  })

  test("uses a stable fallback order for mixed or unknown work", () => {
    const input = { summary: "Handle this general task", strategies }
    expect(routeDeterministic(input).id).toBe(routeDeterministic(input).id)
    expect(routeDeterministic(input).alternatives.map((item) => item.id)).toEqual(
      routeDeterministic(input).alternatives.map((item) => item.id),
    )
  })

  test("prefers background only for independent work", () => {
    const foreground = routeDeterministic({
      summary: "Implement a focused code fix in the current session",
      strategies,
      backgroundPreference: true,
    })
    const independent = routeDeterministic({
      summary: "Run this independent background analysis in parallel",
      strategies,
      backgroundPreference: true,
    })

    expect(foreground.background).toBe(false)
    expect(independent.background).toBe(true)
  })

  test("selects verification from task signals and available mechanisms", () => {
    expect(routeDeterministic({ summary: "Add tests for this code change", strategies }).verification).toBe("tests")
    expect(routeDeterministic({ summary: "Review the architecture and diagnosis", strategies }).verification).toBe("oracle")
    expect(routeDeterministic({ summary: "Inspect this screenshot for visual evidence", strategies }).verification).toBe("observer")
    expect(routeDeterministic({ summary: "Do the small change", strategies }).verification).toBe("none")
  })

  test("returns finite ranked alternatives and sanitizes fallback metadata", () => {
    const result = routeDeterministic({
      summary: "General task",
      strategies,
      fallbackReason: "SemIf\nfailed because /private/path and a very long detail that should be clipped ".repeat(20),
    })

    expect(result.alternatives.length).toBeLessThanOrEqual(16)
    expect(result.alternatives.every((item) => Number.isFinite(item.score))).toBe(true)
    expect(result.alternatives.every((item) => strategies.some((strategy) => strategy.id === item.id))).toBe(true)
    expect(result.fallbackReason).not.toContain("\n")
    expect(result.fallbackReason!.length).toBeLessThanOrEqual(160)
    expect(result.fallbackReason).not.toContain("/private/path")
  })

  test("bounds the summary and each evidence item before tokenization", () => {
    const summary = `${"x".repeat(10_000)} UI implementation`
    const evidence = [`${"y".repeat(10_000)} screenshot`, "implementation"]
    const result = routeDeterministic({ summary, evidence, strategies })

    expect(result.agent).toBe("fixer")
    expect(result.id).toBe(routeDeterministic({ summary, evidence, strategies }).id)
  })

  test("respects explicit field constraints when alternatives contain them", () => {
    const result = routeDeterministic({
      summary: "Implement and test this change",
      strategies: generateStrategies({ ...strategyInput, explicit: { agent: "fixer", verification: "tests" } }),
    })

    expect(result.strategy.agent).toBe("fixer")
    expect(result.verification).toBe("tests")
    expect(result.alternatives).toHaveLength(2)
  })
})
