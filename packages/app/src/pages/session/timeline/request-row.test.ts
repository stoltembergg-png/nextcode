import { expect, test } from "bun:test"
import { openRequestKinds, requestRowOffset, requestScrollPadding, timelinePaddingEnd } from "./request-row"

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

test("places a request row after titled timeline content", () => {
  const height = 48
  const scrollMargin = 64
  const contentEnd = 320
  const totalSize = contentEnd + requestScrollPadding(height)
  expect(requestRowOffset({ totalSize, requestHeight: height, scrollMargin })).toBe(contentEnd)
})
