import { expect, test } from "bun:test"
import { openRequestKinds, requestScrollPadding, timelinePaddingEnd } from "./request-row"

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
