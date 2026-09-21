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

  test("skips linuxdeploy strip on ubuntu-24.04 AppImage", () => {
    const step = yaml.slice(yaml.indexOf("name: Build the bundle"))
    expect(step).toMatch(/NO_STRIP:\s*["']?true["']?/)
  })

  test("points linuxdeploy at staged llama-server libraries", () => {
    const step = yaml.slice(yaml.indexOf("name: Build the bundle"))
    expect(step).toMatch(/LD_LIBRARY_PATH/)
    expect(step).toContain("src-tauri/semif")
  })

  test("stages a linux sidecar wrapper instead of the bun ELF", () => {
    expect(yaml).toContain("stage-opencode-sidecar.ts")
  })

  test("collects the AppImage with the same quoting as the other platforms", () => {
    const step = yaml.slice(yaml.indexOf("name: Collect artifacts"))
    expect(step).toContain('ARTIFACT=$(basename "$(ls "$OUT"/*.AppImage)")')
    expect(step).not.toContain('*.AppImage")')
  })
})
