import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeBundledWayland } from "./unbundle-appimage-wayland"

describe("unbundle appimage wayland", () => {
  test("deletes libwayland client cursor egl and server copies", () => {
    const root = mkdtempSync(path.join(tmpdir(), "appimage-wayland-"))
    const lib = path.join(root, "usr", "lib")
    mkdirSync(lib, { recursive: true })
    writeFileSync(path.join(lib, "libwayland-client.so.0"), "client")
    writeFileSync(path.join(lib, "libwayland-cursor.so.0"), "cursor")
    writeFileSync(path.join(lib, "libwayland-egl.so.1"), "egl")
    writeFileSync(path.join(lib, "libwayland-server.so.0"), "server")
    writeFileSync(path.join(lib, "libgtk-3.so.0"), "keep")

    const removed = removeBundledWayland(root)
    expect(removed.sort()).toEqual(
      [
        path.join(lib, "libwayland-client.so.0"),
        path.join(lib, "libwayland-cursor.so.0"),
        path.join(lib, "libwayland-egl.so.1"),
        path.join(lib, "libwayland-server.so.0"),
      ].sort(),
    )
    expect(readdirSync(lib)).toEqual(["libgtk-3.so.0"])
  })
})
