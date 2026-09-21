import { describe, expect, test } from "bun:test"
import { runWindowMenuAction } from "./desktop-menu-window"

const record = () => {
  const calls: string[] = []
  return {
    calls,
    window: {
      minimize: async () => {
        calls.push("minimize")
      },
      toggleMaximize: async () => {
        calls.push("toggleMaximize")
      },
      close: async () => {
        calls.push("close")
      },
    },
  }
}

describe("runWindowMenuAction", () => {
  test("minimizes", async () => {
    const harness = record()
    await runWindowMenuAction("window.minimize", harness.window)
    expect(harness.calls).toEqual(["minimize"])
  })
  test("toggles maximize", async () => {
    const harness = record()
    await runWindowMenuAction("window.maximize", harness.window)
    expect(harness.calls).toEqual(["toggleMaximize"])
  })
  test("closes", async () => {
    const harness = record()
    await runWindowMenuAction("window.close", harness.window)
    expect(harness.calls).toEqual(["close"])
  })
  test("ignores unknown actions", async () => {
    const harness = record()
    await runWindowMenuAction("view.reload", harness.window)
    expect(harness.calls).toEqual([])
  })
})
