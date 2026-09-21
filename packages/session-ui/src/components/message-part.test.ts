import { describe, expect, mock, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { readPartText } from "./message-part-text"

mock.module("./markdown.worker.ts?worker&url", () => ({ default: "/mock-worker.js" }))

const { renderable } = await import("./message-part")

function reasoningPart(id: string, text: string): Part {
  return {
    id,
    sessionID: "session",
    messageID: "message",
    type: "reasoning",
    text,
    time: { start: 0 },
  }
}

test("renderable reasoning stays a row even when summaries are off", () => {
  expect(renderable(reasoningPart("prt_1", "need to inspect foo"), false)).toBe(true)
  expect(renderable(reasoningPart("prt_2", "   "), true)).toBe(false)
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
