import { describe, expect, test } from "bun:test"
import { summarize } from "../../src/semif/calibration"
import fixture from "./calibration.fixture.json"

describe("semif calibration", () => {
  test("summarize matches hand metrics on the fixture", () => {
    const result = summarize(fixture.cases)
    expect(result.accuracy).toBeCloseTo(0.75, 5)
    expect(result.brier).toBeCloseTo(
      ((0.9 - 1) ** 2 +
        (0.1 - 0) ** 2 +
        (0.6 - 1) ** 2 +
        (0.4 - 0) ** 2 +
        (0.2 - 0) ** 2 +
        (0.8 - 1) ** 2 +
        (0.55 - 0) ** 2 +
        (0.45 - 1) ** 2) /
        4,
      5,
    )
    expect(result.coverage["0.8"]?.covered).toBeCloseTo(0.5, 5)
    expect(result.coverage["0.8"]?.accuracy).toBeCloseTo(1, 5)
  })
})
