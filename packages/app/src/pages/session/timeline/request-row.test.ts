import { expect, test } from "bun:test"
import {
  openQuestionPart,
  openRequestKinds,
  requestRowOffset,
  requestScrollPadding,
  timelinePaddingEnd,
} from "./request-row"

test("lists an open permission and question once", () => {
  expect(openRequestKinds({ permission: true, question: false })).toEqual(["permission"])
  expect(openRequestKinds({ permission: false, question: false })).toEqual([])
  expect(openRequestKinds({ permission: true, question: true })).toEqual(["permission", "question"])
})

test("adds open request rows to the end padding scrollToEnd uses", () => {
  expect(requestScrollPadding(0)).toBe(timelinePaddingEnd)
  expect(requestScrollPadding(48)).toBe(timelinePaddingEnd + 48)
  expect(requestScrollPadding(-8)).toBe(timelinePaddingEnd)
})

test("keeps an empty titled timeline request row inside the content box", () => {
  const height = 48
  const scrollMargin = 64
  const totalSize = requestScrollPadding(height) - scrollMargin
  const offset = requestRowOffset({ totalSize, requestHeight: height, scrollMargin })
  expect(offset).not.toBe(-64)
  expect(offset).toBeGreaterThanOrEqual(0)
  expect(offset).toBe(0)
})

test("hides only the pending question part that opened the request", () => {
  const request = { tool: { messageID: "msg_open", callID: "call_open" } }
  const pending = {
    tool: "question",
    messageID: "msg_open",
    callID: "call_open",
    state: { status: "pending" },
  }
  expect(openQuestionPart(request, pending)).toBe(true)
  expect(openQuestionPart(request, { ...pending, state: { status: "running" } })).toBe(true)
  expect(openQuestionPart(request, { ...pending, callID: "call_other" })).toBe(false)
  expect(openQuestionPart(request, { ...pending, messageID: "msg_other" })).toBe(false)
  expect(openQuestionPart(request, { ...pending, tool: "bash" })).toBe(false)
  expect(openQuestionPart(request, { ...pending, state: { status: "completed" } })).toBe(false)
  expect(openQuestionPart(undefined, pending)).toBe(false)
  expect(openQuestionPart({}, pending)).toBe(false)
})

test("places a request row after titled timeline content", () => {
  const height = 48
  const scrollMargin = 64
  const contentEnd = 320
  const totalSize = contentEnd + requestScrollPadding(height)
  expect(requestRowOffset({ totalSize, requestHeight: height, scrollMargin })).toBe(contentEnd)
})
