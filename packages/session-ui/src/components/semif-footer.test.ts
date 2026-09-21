import { describe, expect, test } from "bun:test"
import type { UiI18nKey, UiI18nParams, UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"
import { semifFooterForPart, semifFooterLabel, type SemifFooterPart } from "./semif-footer"

const dict: Record<string, string> = {
  "ui.message.semif.none": "No Semif",
  "ui.message.semif.routed": "Semif",
  "ui.message.semif.tokens": "{{tokens}} tokens",
  "ui.message.semif.decisions.one": "{{count}} decision",
  "ui.message.semif.decisions.other": "{{count}} decisions",
}

function fill(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, key: string) => {
    const value = params[key]
    return value === undefined ? "" : String(value)
  })
}

const t = (key: UiI18nKey, params?: UiI18nParams) => fill(dict[key] ?? key, params)
const plural = (key: UiI18nPluralKey, count: number, params?: UiI18nParams) => {
  const category = count === 1 ? "one" : "other"
  return fill(dict[`${key}.${category}`] ?? "", { ...params, count })
}

function delegate(source: string, status = "completed"): SemifFooterPart {
  return { type: "tool", tool: "omo_delegate", state: { status, metadata: { source } } }
}

function decide(input_tokens: unknown, status = "completed"): SemifFooterPart {
  return { type: "tool", tool: "semif_decide", state: { status, metadata: { input_tokens } } }
}

function label(parts: readonly SemifFooterPart[], locale = "en") {
  return semifFooterLabel({ parts, locale, t, plural })
}

describe("semifFooterLabel", () => {
  test("says No Semif when the turn has no Semif evidence", () => {
    expect(label([])).toBe("No Semif")
    expect(label([delegate("deterministic"), delegate("explicit")])).toBe("No Semif")
    expect(label([{ type: "text" }, decide(10, "pending"), decide(10, "error"), decide(10, "running")])).toBe(
      "No Semif",
    )
  })

  test("says Semif when a delegate was routed by Semif and no decision completed", () => {
    expect(label([delegate("deterministic"), delegate("semif", "running")])).toBe("Semif")
    expect(label([delegate("semif", "error")])).toBe("Semif")
  })

  test("counts completed decisions and sums local tokens", () => {
    expect(label([decide(400), decide(440), decide(-5), decide(Number.NaN), decide(undefined)])).toBe(
      "Semif · 5 decisions · 840 tokens",
    )
    expect(label([decide(0), decide(undefined)])).toBe("Semif · 2 decisions")
    expect(label([decide(12)])).toBe("Semif · 1 decision · 12 tokens")
  })

  test("formats token totals at 1000 and above with compact notation", () => {
    const text = label([decide(1500)])
    expect(text.startsWith("Semif · 1 decision · ")).toBe(true)
    expect(text.endsWith(" tokens")).toBe(true)
    expect(text).not.toContain("1500")
  })
})

describe("semifFooterForPart", () => {
  test("returns the phrase only for the copy part", () => {
    expect(semifFooterForPart("part_copy", "part_copy", "No Semif")).toBe("No Semif")
    expect(semifFooterForPart("part_copy", "part_other", "No Semif")).toBeUndefined()
    expect(semifFooterForPart(null, "part_copy", "No Semif")).toBeUndefined()
    expect(semifFooterForPart(undefined, "part_copy", "No Semif")).toBeUndefined()
  })
})
