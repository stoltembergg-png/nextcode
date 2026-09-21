import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const yaml = readFileSync(join(import.meta.dir, "../../../.github/workflows/tauri-release.yml"), "utf8")

describe("tauri-release linux", () => {
  test("cross-compiles the linux sidecar", () => {
    expect(yaml).toContain("opencode-linux-x64")
    expect(yaml).toMatch(/--targets=opencode-windows-x64,opencode-darwin-arm64,opencode-linux-x64/)
  })

  test("includes an ubuntu appimage matrix row", () => {
    expect(yaml).toContain("ubuntu-24.04")
    expect(yaml).toMatch(/bundles:\s*appimage/)
  })

  test("installs webkitgtk 4.1 before the linux bundle", () => {
    expect(yaml).toContain("libwebkit2gtk-4.1-dev")
    expect(yaml).toContain("libayatana-appindicator3-dev")
    expect(yaml).toContain("patchelf")
  })
})
