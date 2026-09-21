import { describe, expect, test } from "bun:test"
import { composerStrip } from "./session-composer-strip"

describe("composerStrip", () => {
  test("omits the strip when nothing is pending", () => {
    expect(
      composerStrip({
        todos: [],
        revertCount: 0,
        expanded: false,
        onToggle() {},
        todoLabel: () => "",
        revertLabel: () => "",
      }),
    ).toBeUndefined()
  })

  test("joins todo progress and revert summary", () => {
    const strip = composerStrip({
      todos: [{ status: "completed" }, { status: "pending" }],
      revertCount: 2,
      expanded: false,
      onToggle() {},
      todoLabel: (done, total) => `${done} of ${total} todos completed`,
      revertLabel: (count) => `${count} rolled back messages`,
    })
    expect(strip?.label).toBe("1 of 2 todos completed · 2 rolled back messages")
  })
})
