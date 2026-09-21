import { describe, expect, test } from "bun:test"
import { captionGutterOs, captionGutterWidthPx } from "./titlebar"

describe("caption gutter", () => {
  test("windows and linux reserve caption space", () => {
    expect(captionGutterOs("windows")).toBe(true)
    expect(captionGutterOs("linux")).toBe(true)
    expect(captionGutterOs("macos")).toBe(false)
  })
  test("width matches windows 138px at zoom 1", () => {
    expect(captionGutterWidthPx(1)).toBe("138px")
  })
})
