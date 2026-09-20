import { describe, expect, test } from "bun:test"
import type { SemifDecision } from "../../src/semif/scoring"
import { assertRealModelDecision, REAL_MODEL_STRATEGIES, sanitizeProbeReport } from "../../script/omo-real-model"

function validDecision(): SemifDecision {
  const options = REAL_MODEL_STRATEGIES.slice(0, 3)
  return {
    id: "contract-test",
    option_ids: options.map((option) => option.id),
    probabilities: [0.6, 0.3, 0.1],
    option_logits: [2, 1, 0],
    answer_token_ids: [542, 543, 544],
    chosen: options[0]!.id,
    input_tokens: 10,
    prompt_sha256: "a".repeat(64),
    prompt_version: "direct-options-v1",
    model: { source: "LiquidAI/LFM2-1.2B", revision: "Q4_K_M", server: "llama.cpp b11040" },
    probability_status: "conditional option score; uncalibrated as decision confidence",
    readout: "test",
    forward_seconds: 0.1,
    total_seconds: 0.2,
    missing_slots: [],
  }
}

describe("real-model SemIf contract", () => {
  test("offers no more than sixteen slots and every slot is an eligible strategy", () => {
    expect(REAL_MODEL_STRATEGIES.length).toBeGreaterThan(1)
    expect(REAL_MODEL_STRATEGIES.length).toBeLessThanOrEqual(16)
    const eligible = new Set(REAL_MODEL_STRATEGIES.map((strategy) => strategy.id))
    expect(REAL_MODEL_STRATEGIES.every((strategy) => eligible.has(strategy.id))).toBe(true)
  })

  test("accepts finite orderable scores without asserting a probability threshold", () => {
    expect(() => assertRealModelDecision(validDecision())).not.toThrow()
  })

  test("rejects malformed, missing, duplicate, and ineligible answer slots", () => {
    const missing = { ...validDecision(), missing_slots: ["fixer:foreground:tests"] }
    expect(() => assertRealModelDecision(missing)).toThrow("answer_slot_missing")

    const malformed = { ...validDecision(), option_ids: ["not-a-strategy", "fixer:foreground:tests"] }
    expect(() => assertRealModelDecision(malformed)).toThrow("option_slot_ineligible")

    const duplicate = { ...validDecision(), option_ids: ["explore:foreground:none", "explore:foreground:none"] }
    expect(() => assertRealModelDecision(duplicate)).toThrow("option_slots_duplicate")

    const tooMany = {
      ...validDecision(),
      option_ids: Array.from({ length: 17 }, (_, index) => `strategy-${index}`),
    }
    expect(() => assertRealModelDecision(tooMany)).toThrow("option_count_out_of_range")
  })

  test("rejects non-finite scores and a missing selected strategy", () => {
    expect(() => assertRealModelDecision({ ...validDecision(), probabilities: [Number.NaN, 0.3, 0.1] })).toThrow(
      "probability_not_finite",
    )
    expect(() => assertRealModelDecision({ ...validDecision(), chosen: "missing" })).toThrow(
      "chosen_strategy_ineligible",
    )
  })

  test("sanitizes lifecycle output and excludes prompts, paths, and arbitrary fields", () => {
    const report = sanitizeProbeReport({
      status: "passed",
      lifecycle: ["offline", "starting", "ready", "disposing", "disposed", "secret-stage"],
      tasks: [
        {
          task: "explore",
          chosen: REAL_MODEL_STRATEGIES[0]!.id,
          eligible: true,
          option_count: 6,
          score_count: 6,
          missing_slots: 0,
          total_seconds: 1.23456,
          prompt: "do not emit this task prompt",
          modelPath: "C:\\private\\model.gguf",
        },
      ],
      secret: "do not emit this value",
    })
    const encoded = JSON.stringify(report)
    expect(report.lifecycle).toEqual(["offline", "starting", "ready", "disposing", "disposed"])
    expect(report.tasks[0]?.total_seconds).toBe(1.235)
    expect(encoded).not.toContain("do not emit")
    expect(encoded).not.toContain("private")
    expect(encoded).not.toContain("modelPath")
  })
})
