# Linux Desktop (x86_64 AppImage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Linux x86_64 AppImage of the NextCode Tauri shell on the existing `tauri-release` pipeline, with frameless titlebar caption buttons and a kill-on-exit sidecar process group, without user SDK or apt setup.

**Architecture:** Add a Linux bundle config and CI matrix row. Cross-compile `opencode-linux-x64` next to the Windows/macOS sidecars. Vendor the pinned CPU `llama-server` Ubuntu archive. Keep `decorations: false` and draw Linux caption buttons in the existing Solid titlebar. Unix `killpg` replaces the Windows Job Object for orphan cleanup.

**Tech Stack:** Tauri 2, WebKitGTK 4.1, Bun `--compile` sidecar, GitHub Actions `ubuntu-24.04`, existing updater feed.

## Global Constraints

- Default branch baseline: `origin/dev` @ `750653802`.
- First ship is `x86_64` AppImage only. No `.deb`, `.rpm`, or aarch64.
- CI runner: `ubuntu-24.04`. WebKitGTK 4.1 via `libwebkit2gtk-4.1-dev`.
- Do not set `LD_LIBRARY_PATH`. Do not change `semif_sidecar_env` to use it; the non-Windows `DYLD_FALLBACK_LIBRARY_PATH` no-op on Linux is intentional.
- Do not enable `tauri-plugin-decorum` on Linux.
- Do not bundle Vulkan/HIP into the AppImage; CPU `llama-server` only, same as Windows/macOS vendor step.
- Do not edit SemIf scoring, routing, or acquire logic in this plan.
- Overlap file `.github/workflows/tauri-release.yml` is owned by this plan. The SemIf routing plan must not touch it.
- After public Protocol/`HttpApi` changes, run `bun run generate` from `packages/client`. This plan should not need that.
- Tests run from package directories, never repo root.
- Typecheck with `bun typecheck` from the package directory.
- Conventional commits: `feat(desktop): ...` / `fix(desktop): ...` / `docs: ...`.
- English UI copy lives in `packages/app/src/i18n/en.ts`; reuse `desktop.menu.minimize` / `desktop.menu.maximize` / `desktop.menu.closeWindow`.
- Branch: `cursor/linux-desktop-plan-6cba`.

**Spec:** `docs/superpowers/specs/2026-09-21-linux-desktop-design.md`

## File map

| File | Role |
|---|---|
| `packages/desktop/src-tauri/tauri.conf.json` | Keep `nsis` as the default Windows target; Linux overrides in a platform conf |
| `packages/desktop/src-tauri/tauri.linux.conf.json` | Create: AppImage target, frameless window (same metrics) |
| `.github/workflows/tauri-release.yml` | Sidecar `opencode-linux-x64`, Ubuntu matrix, WebKitGTK deps, stage + vendor |
| `.github/workflows/tauri-shell-linux.yml` | Create: Linux sidecar + AppImage extract smoke |
| `packages/desktop/src-tauri/src/main.rs` | Unix process group; keep Windows Job Object |
| `packages/desktop/src-tauri/Cargo.toml` | `libc` unix dependency if needed |
| `packages/desktop/src/renderer/tauri-api.ts` | Wire `runDesktopMenuAction` to `getCurrentWindow()` |
| `packages/app/src/components/titlebar.tsx` | Linux caption gutter + buttons |
| `packages/app/src/components/linux-caption-controls.tsx` | Create: three buttons |
| `README.md`, `docs/AVALIACAO.md`, `specs/tauri-migration.md` | Product scope includes Linux AppImage |

---

### Task 1: Linux Tauri bundle config

**Files:**
- Create: `packages/desktop/src-tauri/tauri.linux.conf.json`
- Modify: `packages/desktop/src-tauri/tauri.conf.json` (only if a comment is required; prefer leaving Windows `targets: ["nsis"]` and letting `--bundles appimage` plus platform conf override)
- Test: `packages/desktop/src-tauri/tauri.linux.conf.json` is JSON-valid (assert from a small bun test or `node -e JSON.parse`)

**Interfaces:**
- Consumes: existing `tauri.conf.json` window metrics (`width` 1200, `height` 800, `minWidth` 800, `minHeight` 600, `decorations` false).
- Produces: Linux-only bundle target `appimage`.

- [ ] **Step 1: Write the failing config parse test**

Create `packages/desktop/src-tauri/tauri.linux.conf.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src-tauri/tauri.linux.conf.test.ts` from `packages/desktop`

Expected: FAIL — file not found.

- [ ] **Step 3: Add `tauri.linux.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "targets": ["appimage"]
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "NextCode",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": false,
        "resizable": true,
        "dragDropEnabled": false
      }
    ]
  }
}
```

Do not add `tauri-plugin-decorum` here. Do not add `.deb`.

- [ ] **Step 4: Re-run test**

Run: `bun test src-tauri/tauri.linux.conf.test.ts` from `packages/desktop`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src-tauri/tauri.linux.conf.json packages/desktop/src-tauri/tauri.linux.conf.test.ts
git commit -m "feat(desktop): add linux appimage tauri config"
```

---

### Task 2: Release pipeline builds Linux AppImage

**Files:**
- Modify: `.github/workflows/tauri-release.yml`
- Test: grep assertions via a small workflow fixture test if one exists; otherwise add `packages/desktop/test/tauri-release-linux.test.ts` that reads the YAML as text.

**Interfaces:**
- Consumes: sidecar dist layout `packages/opencode/dist/opencode-linux-x64/bin/opencode`; lock triple `x86_64-unknown-linux-gnu` CPU archive.
- Produces: matrix row `ubuntu-24.04` + `appimage`; sidecar target list includes `opencode-linux-x64`.

- [ ] **Step 1: Write the failing workflow contract test**

Create `packages/desktop/test/tauri-release-linux.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tauri-release-linux.test.ts` from `packages/desktop`

Expected: FAIL — `opencode-linux-x64` missing from `--targets`.

- [ ] **Step 3: Sidecar targets**

In `.github/workflows/tauri-release.yml` sidecar build step, replace:

```yaml
run: bun run build --skip-embed-web-ui --targets=opencode-windows-x64,opencode-darwin-arm64
```

with:

```yaml
run: bun run build --skip-embed-web-ui --targets=opencode-windows-x64,opencode-darwin-arm64,opencode-linux-x64
```

- [ ] **Step 4: Matrix row**

Under `build.strategy.matrix.include` add:

```yaml
          - platform: ubuntu-24.04
            bundles: appimage
```

- [ ] **Step 5: Stage sidecar Linux case**

Replace the `*) echo "unsupported runner"; exit 1 ;;` in **Stage the sidecar for externalBin** with a Linux arm:

```bash
            Linux)
              cp packages/opencode/dist/opencode-linux-x64/bin/opencode \
                 "packages/desktop/src-tauri/binaries/opencode-cli-${TRIPLE}"
              chmod +x "packages/desktop/src-tauri/binaries/opencode-cli-${TRIPLE}"
              ;;
            *) echo "unsupported runner"; exit 1 ;;
```

In **Vendor the llama-server runtime**, replace the vendor `*) unsupported` with:

```bash
            Linux) EXT=.tar.gz ;;
            *) echo "unsupported runner"; exit 1 ;;
```

Keep using `$TRIPLE` from `rustc` (`x86_64-unknown-linux-gnu` on the Ubuntu runner). Do **not** append `-vulkan`.

- [ ] **Step 6: WebKitGTK apt step**

Insert before **Build the bundle**, `if: matrix.platform == 'ubuntu-24.04'`:

```yaml
      - name: Install WebKitGTK (Linux)
        if: matrix.platform == 'ubuntu-24.04'
        run: |
          set -euo pipefail
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Pass `--config src-tauri/tauri.ci.conf.json` as today. Tauri merges `tauri.linux.conf.json` automatically on Linux hosts. Keep `--bundles "${{ matrix.bundles }}"`.

- [ ] **Step 7: Re-run test**

Run: `bun test test/tauri-release-linux.test.ts` from `packages/desktop`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/tauri-release.yml packages/desktop/test/tauri-release-linux.test.ts
git commit -m "feat(desktop): build linux appimage on tauri-release"
```

---

### Task 3: Unix sidecar process group

**Files:**
- Modify: `packages/desktop/src-tauri/src/main.rs`
- Modify: `packages/desktop/src-tauri/Cargo.toml` (add `libc` under `[target.'cfg(unix)'.dependencies]`)

**Interfaces:**
- Consumes: `spawn_sidecar` pid; `kill_sidecar`; `RunEvent::Exit`.
- Produces: `bind_sidecar_to_process_group(pid)` on unix; `kill_sidecar_group(pid)` on Exit and `kill_sidecar`.

- [ ] **Step 1: Add unix libc dep**

In `packages/desktop/src-tauri/Cargo.toml`:

```toml
[target.'cfg(unix)'.dependencies]
libc = "0.2"
```

Leave `[target."cfg(windows)".dependencies]` unchanged.

- [ ] **Step 2: Process group helpers**

In `main.rs` next to `bind_sidecar_to_job`, add:

```rust
#[cfg(unix)]
fn bind_sidecar_to_process_group(pid: u32) {
    let pgid = pid as i32;
    let result = unsafe { libc::setpgid(pgid, pgid) };
    if result != 0 {
        log::error!("[shell] setpgid failed for sidecar {pid}");
        return;
    }
    log::info!("[shell] sidecar {pid} bound to process group");
}

#[cfg(not(unix))]
fn bind_sidecar_to_process_group(_pid: u32) {}

#[cfg(unix)]
fn kill_sidecar_group(pid: u32) {
    let pgid = pid as i32;
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn kill_sidecar_group(_pid: u32) {}
```

Call `bind_sidecar_to_process_group(pid)` immediately after a successful spawn (alongside the Job Object block).

In `kill_sidecar` and `RunEvent::Exit`, after taking `child`, call `kill_sidecar_group(pid)` then `child.kill()`.

Do not change Windows Job Object flags.

- [ ] **Step 3: `cargo check`**

Run: `cargo check` from `packages/desktop/src-tauri`

Expected: PASS on the current host. On Linux CI this compiles the unix cfg; locally on the agent (Linux) `setpgid`/`killpg` must typecheck.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src-tauri/src/main.rs packages/desktop/src-tauri/Cargo.toml packages/desktop/src-tauri/Cargo.lock
git commit -m "fix(desktop): kill linux sidecar process group on exit"
```

---

### Task 4: Wire Tauri `runDesktopMenuAction`

**Files:**
- Modify: `packages/desktop/src/renderer/tauri-api.ts`
- Test: `packages/desktop/src/renderer/tauri-api.test.ts` (create if missing; if window APIs cannot run in bun, extract a pure mapper)

**Interfaces:**
- Consumes: action ids `window.minimize` | `window.maximize` | `window.close` (see `packages/app/src/desktop-menu.ts` and `main.rs` `run_menu_action`).
- Produces: shim that calls `getCurrentWindow().minimize()` / `toggleMaximize()` / `close()`.

- [ ] **Step 1: Extract a pure dispatcher so bun can test it**

Create `packages/desktop/src/renderer/desktop-menu-window.ts`:

```ts
export type WindowHandle = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
}

export function runWindowMenuAction(action: string, window: WindowHandle): Promise<void> {
  if (action === "window.minimize") return window.minimize()
  if (action === "window.maximize") return window.toggleMaximize()
  if (action === "window.close") return window.close()
  return Promise.resolve()
}
```

Create `packages/desktop/src/renderer/desktop-menu-window.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/renderer/desktop-menu-window.test.ts` from `packages/desktop`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement dispatcher + shim**

In `tauri-api.ts` replace the stub:

```ts
runDesktopMenuAction: (action: string) => runWindowMenuAction(action, getCurrentWindow()),
```

Import `runWindowMenuAction` from `./desktop-menu-window`. `getCurrentWindow()` already satisfies `minimize` / `toggleMaximize` / `close`.

- [ ] **Step 4: Re-run tests**

Run: `bun test src/renderer/desktop-menu-window.test.ts` from `packages/desktop`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/desktop-menu-window.ts packages/desktop/src/renderer/desktop-menu-window.test.ts packages/desktop/src/renderer/tauri-api.ts
git commit -m "fix(desktop): wire tauri window menu actions"
```

---

### Task 5: Linux caption buttons

**Files:**
- Create: `packages/app/src/components/linux-caption-controls.tsx`
- Modify: `packages/app/src/components/titlebar.tsx`
- Modify: `packages/app/src/components/titlebar.css` (only if needed for button hit targets)
- Test: `packages/app/src/components/linux-caption-controls.test.ts`

**Interfaces:**
- Consumes: `Platform.runDesktopMenuAction`; i18n keys `desktop.menu.minimize`, `desktop.menu.maximize`, `desktop.menu.closeWindow`.
- Produces: three buttons; titlebar gutter when `linux()` equals the Windows 138px reservation.

- [ ] **Step 1: Write the failing control test**

Create `packages/app/src/components/linux-caption-controls.test.ts` using the same Solid test helper the titlebar tests use if one exists; otherwise test a pure `linuxCaptionGutterStyle(os: string, zoom: number)` helper in `titlebar.tsx`:

Add next to `windowsControlsBaseWidth`:

```ts
export function captionGutterOs(os: "macos" | "windows" | "linux" | undefined): boolean {
  return os === "windows" || os === "linux"
}

export function captionGutterWidthPx(zoom: number): string {
  return `${windowsControlsBaseWidth / Math.max(zoom, 1)}px`
}
```

Test file `packages/app/src/components/titlebar-caption-gutter.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { captionGutterOs, captionGutterWidthPx } from "./titlebar"

describe("caption gutter", () => {
  test("windows and linux reserve caption space", () => {
    expect(captionGutterOs("windows")).toBe(true)
    expect(captionGutterOs("linux")).toBe(true)
    expect(captionGutterOs("macos")).toBe(false)
  })
  test("width matches windows 138px at zoom 1", () => {
    expect(captionGutterWidthPx(1)).toBe("138px")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/titlebar-caption-gutter.test.ts` from `packages/app`

Expected: FAIL — exports missing.

- [ ] **Step 3: Caption component**

`linux-caption-controls.tsx`:

```tsx
import type { Platform } from "@/context/platform"
import type { useLanguage } from "@/context/language"

export function LinuxCaptionControls(props: {
  platform: Platform
  t: ReturnType<typeof useLanguage>["t"]
}) {
  const act = (action: "window.minimize" | "window.maximize" | "window.close") => {
    void props.platform.runDesktopMenuAction?.(action)
  }
  return (
    <div class="linux-caption-controls shrink-0 flex" data-tauri-drag-region="false">
      <button type="button" class="linux-caption-btn" aria-label={props.t("desktop.menu.minimize")} onClick={() => act("window.minimize")} />
      <button type="button" class="linux-caption-btn" aria-label={props.t("desktop.menu.maximize")} onClick={() => act("window.maximize")} />
      <button type="button" class="linux-caption-btn linux-caption-btn-close" aria-label={props.t("desktop.menu.closeWindow")} onClick={() => act("window.close")} />
    </div>
  )
}
```

Keep markup minimal. Style in `titlebar.css`:

```css
.linux-caption-controls {
  width: 138px;
  height: 100%;
}
.linux-caption-btn {
  width: 46px;
  height: 100%;
}
.linux-caption-btn-close:hover {
  background: #c42b1c;
}
```

In `titlebar.tsx`:

- `minHeight()`: treat `linux()` like `windows()`.
- Width/max-width/margin-right: use `captionGutterOs(platform.os)` instead of `windows()` only.
- Replace `<Show when={windows()}>` spacer with `<Show when={windows() || linux()}>` and render `<LinuxCaptionControls>` when `linux()`.

Do not render Linux buttons on Windows (decorum still owns those).

- [ ] **Step 4: Re-run tests + typecheck**

Run from `packages/app`:

```bash
bun test src/components/titlebar-caption-gutter.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/titlebar.tsx packages/app/src/components/linux-caption-controls.tsx packages/app/src/components/titlebar.css packages/app/src/components/titlebar-caption-gutter.test.ts
git commit -m "feat(app): add linux frameless caption controls"
```

---

### Task 6: Linux shell smoke workflow

**Files:**
- Create: `.github/workflows/tauri-shell-linux.yml`

**Interfaces:**
- Consumes: sidecar target `opencode-linux-x64`; AppImage bundle.
- Produces: a path-filtered workflow that extracts the AppImage and asserts `opencode-cli-` + `llama-server` exist.

- [ ] **Step 1: Add workflow**

Mirror `.github/workflows/tauri-shell-macos.yml` structure. Differences:

```yaml
name: tauri-shell-linux
on:
  workflow_dispatch:
  push:
    branches: [tauri-shell, cursor/linux-desktop-plan-6cba, dev]
    paths:
      - "packages/desktop/**"
      - "packages/app/**"
      - "packages/ui/**"
      - "packages/session-ui/**"
      - "packages/client/**"
      - "packages/identity/**"
      - "packages/opencode/**"
      - ".github/workflows/tauri-shell-linux.yml"
jobs:
  sidecar:
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    steps:
      # checkout, bun, install, build --targets=opencode-linux-x64, upload artifact
  shell:
    needs: sidecar
    runs-on: ubuntu-24.04
    timeout-minutes: 90
    steps:
      # bun install, rust-toolchain, webkitgtk apt, download sidecar,
      # stage binary, fetch CPU llama-server, bun run build:renderer-tauri,
      # bun run tauri build --config src-tauri/tauri.linux.conf.json --bundles appimage
      # find the AppImage, --appimage-extract, test -x squashfs-root/usr/bin/opencode-desktop
      # test -e squashfs-root/**/llama-server
```

If `--appimage-extract` is not supported on the produced file, fall back to `binwalk`-free `tail`/`unsquashfs` only if already on the runner; otherwise `chmod +x` the AppImage and `--appimage-extract-and-run --help` is **not** required. The merge gate is: bundle step exit 0 and the AppImage file exists under `target/release/bundle/appimage/`.

Do not add `branches: [tauri-shell]` as the only trigger; include `workflow_dispatch` so this PR can be run manually.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tauri-shell-linux.yml
git commit -m "test(desktop): add linux tauri shell smoke workflow"
```

---

### Task 7: Product docs

**Files:**
- Modify: `README.md`
- Modify: `docs/AVALIACAO.md`
- Modify: `specs/tauri-migration.md`

**Interfaces:**
- Consumes: first-ship table from the spec.
- Produces: Linux AppImage listed next to NSIS and dmg; migration spec non-goal updated.

- [ ] **Step 1: README install list**

Change the tagline and install bullets:

```md
<p align="center">Desktop AI coding agent for Windows, macOS, and Linux.</p>
```

```md
- **Windows 10/11 (x64)** — `NextCode_<version>_x64-setup.exe` (NSIS, per-user install)
- **macOS (Apple Silicon)** — `NextCode_<version>_aarch64.dmg`
- **Linux (x86_64)** — `NextCode_<version>_amd64.AppImage` (Ubuntu 22.04+ / glibc)
```

Build-from-source prerequisites: add `libwebkit2gtk-4.1-dev` on Linux.

`bun run tauri build` sentence: NSIS / dmg / AppImage.

- [ ] **Step 2: AVALIACAO + migration spec**

`docs/AVALIACAO.md`: product line becomes Windows x64 + macOS Apple Silicon + Linux x86_64 AppImage.

`specs/tauri-migration.md`: replace “Linux desktop packaging is dropped” with a short “Linux first ship” subsection pointing at `docs/superpowers/specs/2026-09-21-linux-desktop-design.md`. Keep Electron removal and install→update→restart as pending. Do not claim `.deb`.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/AVALIACAO.md specs/tauri-migration.md
git commit -m "docs: document linux x86_64 appimage first ship"
```

---

## Self-review

- Spec coverage: bundle, sidecar, WebKitGTK CI, process group, caption buttons, updater copy path, smoke, docs, LD_LIBRARY_PATH prohibition — each has a task.
- No `route`/`authoritative`. No `.deb`.
- `tauri-release.yml` is the only overlap file with other in-flight work; routing plan must not edit it.
