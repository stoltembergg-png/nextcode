import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))

describe("tauri linux conf", () => {
  test("ships appimage only and stays frameless", () => {
    const conf = JSON.parse(readFileSync(join(dir, "tauri.linux.conf.json"), "utf8"))
    expect(conf.bundle.targets).toEqual(["appimage"])
    expect(conf.app.windows[0].decorations).toBe(false)
    expect(conf.app.windows[0].width).toBe(1200)
    expect(conf.app.windows[0].minWidth).toBe(800)
  })

  test("keeps the bun sidecar out of linuxdeploy usr/bin", () => {
    const conf = JSON.parse(readFileSync(join(dir, "tauri.linux.conf.json"), "utf8"))
    expect(conf.bundle.linux.appimage.files["/usr/share/opencode/opencode-cli"]).toBe("binaries/opencode-cli-real")
    expect(conf.bundle.linux.deb.files["/usr/share/opencode/opencode-cli"]).toBe("binaries/opencode-cli-real")
  })

  test("disables WebKitGTK DMA-BUF before the webview is created", () => {
    const rust = readFileSync(join(dir, "src/main.rs"), "utf8")
    expect(rust).toContain('std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1")')
    expect(rust).toContain('std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1")')
    expect(rust).toContain('std::env::var_os("APPIMAGE")')
    expect(rust).toContain('std::env::set_var("GDK_BACKEND", "x11")')
  })
})
