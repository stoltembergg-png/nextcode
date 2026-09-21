import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const yaml = readFileSync(join(import.meta.dir, "../../../.github/workflows/tauri-shell-linux.yml"), "utf8")

describe("tauri-shell-linux", () => {
  test("skips linuxdeploy strip on ubuntu-24.04 AppImage", () => {
    const step = yaml.slice(yaml.indexOf("name: Build the AppImage"))
    expect(step).toMatch(/NO_STRIP:\s*["']?true["']?/)
  })

  test("prints linuxdeploy stderr on the AppImage build", () => {
    const step = yaml.slice(yaml.indexOf("name: Build the AppImage"))
    expect(step).toMatch(/tauri build --verbose /)
  })

  test("points linuxdeploy at staged llama-server libraries", () => {
    const step = yaml.slice(yaml.indexOf("name: Build the AppImage"))
    expect(step).toMatch(/LD_LIBRARY_PATH/)
    expect(step).toContain("src-tauri/semif")
  })

  test("runs the AppImage smoke on pull requests to dev", () => {
    expect(yaml).toMatch(/pull_request:\s*\n\s*branches:\s*\[[^\]]*dev/)
  })

  test("stages a linux sidecar wrapper instead of the bun ELF", () => {
    expect(yaml).toContain("stage-opencode-sidecar.ts")
  })

  test("strips bundled libwayland from the AppImage before the payload assert", () => {
    expect(yaml).toContain("unbundle-appimage-wayland.ts")
    expect(yaml).toContain("libwayland-*.so*")
    expect(yaml).toContain("unsquashfs")
  })

  test("resolves the AppImage to an absolute path before cd extract", () => {
    const step = yaml.slice(yaml.indexOf("name: Assert the AppImage payload"))
    expect(step).toContain('APPIMAGE=$(readlink -f "$APPIMAGE")')
  })
})
