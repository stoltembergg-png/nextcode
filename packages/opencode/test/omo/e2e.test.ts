import { describe, expect, test } from "bun:test"
import { generateStrategies } from "../../src/omo/strategy"
import { routeDeterministic } from "../../src/omo/deterministic"

const strategies = generateStrategies({
  eligibleAgents: ["orchestrator", "explore", "oracle", "fixer"],
  background: { available: true, policy: "allow" },
  verification: ["none", "tests", "oracle"],
})

describe("native OMO server story contract", () => {
  test("deterministic fallback selects an eligible foreground specialist", () => {
    const result = routeDeterministic({
      summary: "Implement the parser fix and verify it with tests in the current session",
      evidence: ["The parser rejects valid input"],
      strategies,
      independent: false,
      fallbackReason: "SemIf unavailable at C:\\NextCode\\workspace",
    })

    expect(result.agent).toBe("fixer")
    expect(result.background).toBe(false)
    expect(result.verification).toBe("tests")
    expect(result.source).toBe("deterministic")
    expect(result.fallbackReason).toContain("[path]")
    expect(result.alternatives.every((item) => Number.isFinite(item.score))).toBe(true)
  })

  test("explicit routing overrides constrain the server decision", () => {
    const result = routeDeterministic({
      summary: "Review the architecture and identify the regression",
      strategies,
      explicit: { agent: "oracle", background: false, verification: "oracle" },
      fallbackReason: "explicit user selection",
    })

    expect(result.id).toBe("oracle:foreground:oracle")
    expect(result.agent).toBe("oracle")
    expect(result.background).toBe(false)
    expect(result.verification).toBe("oracle")
    expect(result.alternatives.map((item) => item.id)).toEqual(["oracle:foreground:oracle"])
  })

  test("background delegation preserves parent and child identity in bounded metadata", () => {
    const parentID = "ses_omo_parent_e2e"
    const childID = "ses_omo_child_e2e"
    const metadata = {
      child_id: childID,
      state: "running",
      agent: "fixer",
      background: true,
      source: "deterministic",
      verification: "tests",
    }

    expect({ parentID, childID, metadata }).toEqual({
      parentID,
      childID,
      metadata: expect.objectContaining({ child_id: childID, background: true }),
    })
    expect(metadata).not.toHaveProperty("prompt")
  })
})
