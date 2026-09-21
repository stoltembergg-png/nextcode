import { describe, expect, test } from "bun:test"
import { formatElapsed } from "./thinking-status"

describe("formatElapsed", () => {
  test("hides sub-second elapsed time and never reports negative clock skew", () => {
    expect(formatElapsed(undefined, 1_000, "en")).toBe("")
    expect(formatElapsed(0, 0, "en")).toBe("")
    expect(formatElapsed(0, 999, "en")).toBe("")
    expect(formatElapsed(1_000, 0, "en")).toBe("")
  })

  test("floors elapsed time to localized tenths after one second", () => {
    expect(formatElapsed(0, 1_000, "en")).toBe("1.0s")
    expect(formatElapsed(0, 1_200, "en")).toBe("1.2s")
    expect(formatElapsed(0, 1_200, "pt-BR")).toBe("1,2s")
  })
})
