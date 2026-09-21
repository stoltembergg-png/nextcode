# NextCode Linux desktop (x86_64 AppImage)

**Status:** approved for implementation planning  
**Baseline:** `origin/dev` @ `750653802` (includes SemIf Vulkan PR #16)  
**Non-goals:** `deb`/`rpm`, Linux aarch64, Wayland-only special casing, Mesa/AMDVLK ICD shipping, Electron Linux packaging revival, `route`/`authoritative` SemIf steering

## Problem

The Tauri 2 shell ships Windows x64 (NSIS) and macOS Apple Silicon (dmg/app). Linux desktop was an explicit non-goal of `specs/tauri-migration.md`. The engine already knows Linux:

- Sidecar triples exist (`opencode-linux-x64`, `x86_64-unknown-linux-gnu` in `packages/desktop/scripts/predev-tauri.ts`).
- SemIf pins `llama-b11040-bin-ubuntu-vulkan-x64.tar.gz` and the CPU Ubuntu archive.
- `tauri-release.yml` copies `*.AppImage` if present, then fails the Linux runner with `unsupported runner`.
- `bundle.targets` is `["nsis"]` only.
- The window is `decorations: false`. Windows gets `tauri-plugin-decorum` caption buttons; macOS gets `titleBarStyle: Overlay` traffic lights. Linux gets a frameless window with the app menu but **no min/max/close controls** (`titlebar.tsx` reserves the 138px caption gutter only when `windows()`).

NextCode must be installable on Ubuntu x86_64 the same way it is on Windows/macOS: download an artifact, run it, SemIf warms up with no user SDK/apt step.

## First ship

| Axis | Choice |
|---|---|
| Arch | `x86_64` only (`x86_64-unknown-linux-gnu`) |
| Distro CI | Ubuntu 24.04 (`ubuntu-24.04`, same pin as the sidecar job) |
| Webview | System WebKitGTK 4.1 (Tauri 2 default on Ubuntu 24.04) |
| Artifact | **AppImage** only |
| Sidecar | Cross-compile `opencode-linux-x64` on the existing Ubuntu sidecar job |
| SemIf CPU archive | Vendor `x86_64-unknown-linux-gnu` (existing lock key) into the AppImage like Windows/macOS |
| SemIf Vulkan | On-demand at runtime (already implemented); do not bundle the Vulkan zip |
| Channel | Same `latest.json` / `beta.json` merge; Linux is a third platform fragment |

Defaults used because they were unanswered: no `.deb`, no aarch64, no extra user-facing Linux settings.

## Product rule: fully autonomous

The user does not:

- install the Vulkan SDK, ROCm, or extra NextCode apt repos
- pre-download `llama-server`
- set `semif.backend`
- answer a packaging wizard

Irreducible floor (same class as “a GPU driver exists”):

- A glibc x86_64 Linux with a working WebKitGTK 4.1 stack **on the CI builder**. The **AppImage** must bundle enough of that runtime that a typical Ubuntu 22.04+/Fedora desktop can launch without `apt install webkit2gtk`. If the produced AppImage still requires a system WebKit (Tauri’s current linuxdeploy layout), document that as the floor and fail closed with a shell log — never a setup checklist in the UI.
- A display driver. NextCode does not install GPU drivers. SemIf Vulkan still requires `libvulkan.so.1` from the driver ICD; absence is `missing_vulkan_runtime` and CPU fallback (already specified).

Do **not** set `LD_LIBRARY_PATH` for SemIf. The current `semif_sidecar_env` uses `DYLD_FALLBACK_LIBRARY_PATH` on non-Windows, which is a no-op on Linux and must stay that way (do not “fix” it to `LD_LIBRARY_PATH`). ggml loads colocated `*.so` via `$ORIGIN`.

## Architecture

```text
AppImage
  opencode-desktop          Tauri host (WebKitGTK)
  opencode-cli-<triple>     Bun --compile sidecar (externalBin)
  llama-server              CPU llama.cpp b11040 (externalBin)
  resources/semif/*         ggml CPU libs
  renderer                  packages/app|ui|session-ui (unchanged except titlebar chrome)

Runtime (already exists)
  on-demand HIP/Vulkan      <data>/semif/runtime/{hip,vulkan}-<sha12>/
  GGUF                      <data>/semif/models/<sha12>/
```

Keep `packages/app`, `packages/ui`, `packages/session-ui` byte-identical except the titlebar caption gutter and Linux caption buttons. No UI redesign.

### Window chrome

Keep `decorations: false` (same custom titlebar as Windows). Do **not** enable `tauri-plugin-decorum` on Linux (it is Windows-only today because the cocoa path null-derefs; do not widen that crate).

Linux caption buttons live in the Solid titlebar:

- Show the 138px gutter when `linux()` as well as `windows()`.
- Three icon buttons (minimize / toggle-maximize / close) calling `@tauri-apps/api/window` `getCurrentWindow()` — capabilities already allow `minimize` / `toggle-maximize` / `close`.
- `min-height` for Linux matches Windows (titlebar zoom).
- Reuse existing i18n keys `desktop.menu.minimize`, `desktop.menu.maximize`, `desktop.menu.closeWindow`.
- Wire `window.api.runDesktopMenuAction` in `packages/desktop/src/renderer/tauri-api.ts` (today a no-op stub) so the already-shown `WindowsAppMenu` on Linux actually minimizes/maximizes/closes. Native menu path in `main.rs` `run_menu_action` already implements those actions; expose them through an invoke or call `getCurrentWindow()` from the shim.

### Sidecar lifetime

Windows binds the sidecar to a Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`). Linux `bind_sidecar_to_job` is a no-op. On Linux, the opencode sidecar can orphan `llama-server` if the shell is SIGKILLed.

Unix requirement: put the sidecar in its own process group at spawn and, on `Exit` / `kill_sidecar`, signal the process group (`killpg(pid, SIGTERM)` then `SIGKILL` if needed). Do not introduce a new crate if `libc` on `cfg(unix)` is enough.

### Deep links

`opencode://` is already in `tauri.conf.json` plugins.deep-link. AppImage must ship a `.desktop` with `MimeType=x-scheme-handler/opencode;` (Tauri linux bundle does this when the plugin is enabled). Verify the generated desktop file; do not revive Electron `resources/linux/opencode-desktop.desktop` as the Tauri source of truth.

### Release pipeline

`.github/workflows/tauri-release.yml`:

1. Sidecar job: add `opencode-linux-x64` to `--targets`.
2. Build matrix: add `platform: ubuntu-24.04`, `bundles: appimage`.
3. Stage sidecar: Linux branch of the `RUNNER_OS` case copies `packages/opencode/dist/opencode-linux-x64/bin/opencode` → `opencode-cli-${TRIPLE}` and `chmod +x`.
4. Vendor llama-server: Linux `EXT=.tar.gz`, `NEXTCODE_SEMIF_MIRROR` for the CPU triple (not `-vulkan`). Vulkan stays on-demand.
5. Install WebKitGTK build deps before `tauri build` (Ubuntu 24.04: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`).
6. Existing `find … *.AppImage` copy already works; updater fragment merge already keys by platform — include the Linux signature when the updater key is present.

Do **not** change HIP/Vulkan mirror cases. Routing work must not edit this file.

### Smoke

New `.github/workflows/tauri-shell-linux.yml`, same shape as `tauri-shell-macos.yml` / `tauri-shell-windows.yml`:

- Ubuntu 24.04, path filters on desktop/app/ui/session-ui/client/opencode and the workflow itself.
- Build linux-x64 sidecar, `tauri build --bundles appimage` **or** `tauri dev` with a headed smoke if the runner allows it.
- Assert logs: sidecar spawn, `/global/health` 200, `[shell] server ready`.
- Optional: `--appimage-extract-and-run` only if FUSE is available; otherwise inspect the AppImage payload (`--appimage-extract`) for `opencode-cli-*` and `llama-server`.

Headed WebKit on GitHub-hosted runners is brittle. Log-level sidecar smoke is the merge gate. A real window screenshot is not required to merge.

## Testing

- Unit: titlebar gutter when `os === "linux"`; `runDesktopMenuAction` shim calls window min/max/close.
- Workflow YAML: sidecar targets string includes `opencode-linux-x64`; matrix include has `ubuntu-24.04` + `appimage`.
- Rust: unix process-group kill is `cfg(unix)` and Windows Job Object path is unchanged.
- Docs: README install list includes Linux AppImage; `specs/tauri-migration.md` Linux non-goal is replaced by “first ship: x86_64 AppImage”.

## Out of scope

- `.deb` / `.rpm` / Snap / Flatpak
- `aarch64-unknown-linux-gnu` desktop
- Bundling Vulkan/HIP into the AppImage
- Changing mixed-GPU SemIf policy
- Removing the Electron shell
- `route` / `authoritative` SemIf modes (separate plan, later)
- Setting `LD_LIBRARY_PATH`
