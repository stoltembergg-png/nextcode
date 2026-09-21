#!/usr/bin/env bun
//
// linuxdeploy copies Ubuntu 24.04 libwayland-{client,cursor,egl,server} into the
// AppImage. Host Mesa then fails eglGetPlatformDisplay with EGL_BAD_PARAMETER and
// WebKitWebProcess aborts — before WEBKIT_DISABLE_DMABUF_RENDERER is read.
// Strip those four sonames so the running system supplies a matching client.

import { $ } from "bun"
import { chmodSync, existsSync, mkdtempSync, readdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const WAYLAND = /^(libwayland-(client|cursor|egl|server)\.so)/
const APPIMAGETOOL = "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"

export function removeBundledWayland(root: string): string[] {
  const removed: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      removed.push(...removeBundledWayland(full))
      continue
    }
    if (!WAYLAND.test(entry.name)) continue
    unlinkSync(full)
    removed.push(full)
  }
  return removed
}

if (import.meta.main) {
  const appimage = process.argv[2]
  if (!appimage) {
    console.error("usage: bun packages/desktop/scripts/unbundle-appimage-wayland.ts <AppImage>")
    process.exit(1)
  }
  if (!existsSync(appimage)) throw new Error(`missing AppImage: ${appimage}`)
  const work = mkdtempSync(path.join(tmpdir(), "nextcode-appimage-"))
  const root = path.join(work, "squashfs-root")
  const offsetText = (await $`${appimage} --appimage-offset`.text()).trim()
  const offset = Number(offsetText)
  if (!Number.isFinite(offset)) throw new Error(`appimage offset: ${offsetText}`)
  await $`unsquashfs -f -o ${offset} -d ${root} ${appimage}`
  const removed = removeBundledWayland(root)
  if (removed.length === 0) {
    console.log(`no bundled libwayland in ${appimage}`)
    process.exit(0)
  }
  console.log(removed.map((file) => `removed ${file}`).join("\n"))
  const tool = path.join(work, "appimagetool")
  await $`curl -fsSL ${APPIMAGETOOL} -o ${tool}`
  chmodSync(tool, 0o755)
  const packed = `${appimage}.new`
  await $`env ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 ${tool} ${root} ${packed}`
  await $`mv -f ${packed} ${appimage}`
  chmodSync(appimage, 0o755)
  console.log(`repacked ${appimage} without bundled libwayland`)
}
