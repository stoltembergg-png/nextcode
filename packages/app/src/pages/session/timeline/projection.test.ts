import { describe, expect, test } from "bun:test"
import type { PartGroup } from "@opencode-ai/session-ui/message-part"
import { reuseTimelineRows } from "./row-reconciliation"
import { TimelineRow } from "./timeline-row"

const part = (key: string, partID: string, userMessageID = "user-1") =>
  new TimelineRow.AssistantPart({
    userMessageID,
    group: {
      key,
      type: "part",
      ref: { messageID: "assistant-1", partID },
    } satisfies PartGroup,
    previousAssistantPart: false,
  })

const user = (userMessageID = "user-1") => new TimelineRow.UserMessage({ userMessageID, anchor: true })
const keys = (rows: TimelineRow.TimelineRow[]) => rows.map(TimelineRow.key)

describe("reuseTimelineRows", () => {
  test.each([
    {
      name: "reuses an unchanged part row",
      previous: [part("part:a", "a")],
      rows: [part("part:a", "a")],
      expected: ["assistant-part:user-1:part:a"],
      reused: [[0, 0]],
    },
    {
      name: "reuses an unaffected ordinary row",
      previous: [user()],
      rows: [user()],
      expected: ["user-message:user-1"],
      reused: [[0, 0]],
    },
  ])("$name", ({ previous, rows, expected, reused }) => {
    const result = reuseTimelineRows([...previous], [...rows])

    expect(keys(result)).toEqual([...expected])
    expect(new Set(keys(result)).size).toBe(result.length)
    reused.forEach(([resultIndex, previousIndex]) => expect(result[resultIndex]).toBe(previous[previousIndex]))
  })
})
