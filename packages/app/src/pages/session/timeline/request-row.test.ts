import { expect, test } from "bun:test"
import { openRequestKinds } from "./request-row"

test("lists an open permission and question once", () => {
  expect(openRequestKinds({ permission: true, question: false })).toEqual(["permission"])
  expect(openRequestKinds({ permission: false, question: false })).toEqual([])
  expect(openRequestKinds({ permission: true, question: true })).toEqual(["permission", "question"])
})
