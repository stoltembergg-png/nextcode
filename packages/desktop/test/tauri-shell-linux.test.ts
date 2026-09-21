import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const yaml = readFileSync(join(import.meta.dir, "../../../.github/workflows/tauri-shell-linux.yml"), "utf8")

describe("tauri-shell-linux", () => {
  test("skips linuxdeploy strip on ubuntu-24.04 AppImage", () => {
    const step = yaml.slice(yaml.indexOf("name: Build the AppImage"))
    expect(step).toMatch(/NO_STRIP:\s*["']?true["']?/)
  })
})
