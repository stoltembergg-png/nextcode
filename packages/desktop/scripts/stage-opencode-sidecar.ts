#!/usr/bin/env bun
//
// Stages the compiled opencode binary as the Tauri sidecar for the current Rust
// target. On Linux the Bun ELF cannot sit in usr/bin: linuxdeploy's gtk plugin
// runs ldd/patchelf on every ELF there and aborts. The externalBin slot is a
// shell wrapper; the real binary is copied to binaries/opencode-cli-real and
// packaged at /usr/share/opencode/opencode-cli via tauri.linux.conf.json.

import { $ } from "bun"
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const PLATFORM: Record<string, string> = {
  "aarch64-apple-darwin": "opencode-darwin-arm64",
  "x86_64-apple-darwin": "opencode-darwin-x64",
  "aarch64-pc-windows-msvc": "opencode-windows-arm64",
  "x86_64-pc-windows-msvc": "opencode-windows-x64",
  "aarch64-unknown-linux-gnu": "opencode-linux-arm64",
  "x86_64-unknown-linux-gnu": "opencode-linux-x64",
}

export function linuxSidecarWrapper(): string {
  return `#!/bin/sh
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$HERE/../share/opencode/opencode-cli" ]; then
  exec "$HERE/../share/opencode/opencode-cli" "$@"
fi
if [ -x "$HERE/opencode-cli-real" ]; then
  exec "$HERE/opencode-cli-real" "$@"
fi
echo "opencode-cli: bundled binary not found" >&2
exit 127
`
}

export function stageOpencodeSidecar(input: {
  host: string
  source: string
  destDir: string
}): { wrapper: string; real?: string } {
  mkdirSync(input.destDir, { recursive: true })
  const windows = input.host.includes("windows")
  const exe = windows ? ".exe" : ""
  const wrapper = path.join(input.destDir, `opencode-cli-${input.host}${exe}`)
  if (!input.host.includes("linux")) {
    copyFileSync(input.source, wrapper)
    if (!windows) chmodSync(wrapper, 0o755)
    return { wrapper }
  }
  const real = path.join(input.destDir, "opencode-cli-real")
  copyFileSync(input.source, real)
  chmodSync(real, 0o755)
  writeFileSync(wrapper, linuxSidecarWrapper())
  chmodSync(wrapper, 0o755)
  return { wrapper, real }
}

if (import.meta.main) {
  const desktop = path.resolve(import.meta.dir, "..")
  const repo = path.resolve(desktop, "../..")
  const host = (await $`rustc -vV`.text()).match(/^host: (\S+)/m)?.[1]
  if (!host) throw new Error("could not resolve the Rust host triple (is rustup installed?)")
  const platform = PLATFORM[host]
  if (!platform) throw new Error(`no opencode build target mapped for ${host}`)
  const exe = host.includes("windows") ? ".exe" : ""
  const source = path.join(repo, "packages/opencode/dist", platform, "bin", `opencode${exe}`)
  if (!existsSync(source)) {
    console.error(
      `sidecar binary not found: ${source}\nbuild it first: (cd packages/opencode && bun run build --single)`,
    )
    process.exit(1)
  }
  const destDir = path.join(desktop, "src-tauri/binaries")
  const staged = stageOpencodeSidecar({ host, source, destDir })
  console.log(`sidecar staged: ${staged.wrapper}`)
  if (staged.real) console.log(`sidecar real: ${staged.real}`)
}
