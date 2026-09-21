import { describe, expect, test } from "bun:test"
import { omoDelegateView } from "./omo-delegate"
import { readPartText } from "./message-part-text"

describe("omoDelegateView", () => {
  test("keeps the exact child identity and routing provenance", () => {
    expect(
      omoDelegateView({
        child_id: "ses_child_42",
        state: "running",
        agent: "fixer",
        background: true,
        verification: "tests",
        source: "semif",
      }),
    ).toEqual({
      childID: "ses_child_42",
      state: "running",
      agent: "fixer",
      background: true,
      verification: "tests",
      source: "semif",
    })
  })

  test("preserves completed and error states from structured output", () => {
    expect(omoDelegateView({ child_id: "ses_done", state: "completed" }, "completed")).toMatchObject({
      childID: "ses_done",
      state: "completed",
    })
    expect(omoDelegateView({ child_id: "ses_error", state: "error" }, "completed")).toMatchObject({
      childID: "ses_error",
      state: "error",
    })
  })

  test("does not expose the delegated prompt in the view model", () => {
    const view = omoDelegateView({
      child_id: "ses_child",
      state: "completed",
      prompt: "private task prompt that must not be rendered",
    })
    expect(view).not.toHaveProperty("prompt")
    expect(JSON.stringify(view)).not.toContain("private task prompt")
  })

  test("keeps bounded fallback and downgrade provenance visible", () => {
    expect(
      omoDelegateView({
        child_id: "ses_child",
        state: "completed",
        fallback_reason: "SemIf unavailable",
        downgraded: "background disabled by policy",
      }),
    ).toMatchObject({
      fallbackReason: "SemIf unavailable",
      downgraded: "background disabled by policy",
    })
  })
})

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})
