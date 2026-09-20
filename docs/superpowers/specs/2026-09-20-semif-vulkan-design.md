# SemIf on-demand Vulkan for unsupported AMD GPUs

**Status:** approved for implementation planning  
**Baseline:** `origin/dev` @ `6c989075c` (includes PRs #13 gpu_unsupported, #14 ROCm on-demand, #15 semif-hardening)  
**Non-goal:** CUDA, macOS Vulkan/MoltenVK, user-facing backend picker, installer-bundled GPU binaries

## Problem

SemIf already probes AMD gfx. Windows HIP/ROCm 10.0 only covers TheRock RDNA1+ (`gfx101*`, `gfx103*`, `gfx110*`, `gfx115*`, `gfx120*`). An RX 580 is `gfx803` (Polaris). On that host, `auto` today:

1. Detects AMD.
2. Marks `gpu_unsupported`.
3. Skips HIP/ROCm fetch.
4. Loads `LFM2` GGUF on CPU.

`semif.backend: "vulkan"` is already in the config schema and fetch CLI, but `resolveBackend` stubs it to CPU with `unsupported_variant`. llama.cpp `b11040` (the pinned tag) already publishes:

- `llama-b11040-bin-win-vulkan-x64.zip` (31 821 107 bytes)
- `llama-b11040-bin-ubuntu-vulkan-x64.tar.gz` (30 363 623 bytes)

HIP archives are ~240 MB and need TheRock. Vulkan archives are ~30 MB and do not.

## Product rule: fully autonomous

NextCode must make SemIf GPU work without the user:

- setting `semif.backend`
- installing ROCm, TheRock, the Vulkan SDK, or extra apt packages
- pre-downloading llama.cpp
- answering a wizard

The app downloads, verifies, stages, and launches. Default `semif.mode` / `semif.download` stay `auto`.

Irreducible floor (same class as “a GPU driver exists”): a functioning AMD display driver. Windows Adrenalin for RX 580 already registers a Vulkan ICD. NextCode does not install GPU drivers. It does not tell the user to install a SDK. If the ICD loader (`vulkan-1.dll` / `libvulkan.so.1`) is absent, SemIf stays on CPU with `missing_vulkan_runtime` — never a setup checklist. Sidecar spawn or init failure uses the existing `failed` status (same as HIP); it is not a second Vulkan-specific fallback reason.

## Selection

Variants stay exclusive: `cpu | cuda | hip | vulkan`. `auto` picks one.

| Request | GPU | Active backend |
|---|---|---|
| `auto` | AMD in HIP matrix | HIP (unchanged, including on-demand ROCm on Windows) |
| `auto` | AMD rejected by HIP (`amdGpuUnsupportedForWinHip` or `unsupportedGfx`, e.g. RX 580 / `gfx803`) | Vulkan, fetched on demand |
| `auto` | mixed AMD+NVIDIA | CPU + `mixed_gpus` (unchanged) |
| `auto` | no AMD | CPU + `no_amd_gpu` |
| `hip` | RX 580 / rejected gfx | CPU + `gpu_unsupported` (no silent Vulkan pivot) |
| `vulkan` | any supported host with AMD | Vulkan |
| `cpu` | any | CPU |
| `cuda` | any | CPU + `unsupported_variant` (still a stub) |

Platforms: Windows x64 and Ubuntu x64 only (same `HIP_HOSTS` set). macOS keeps the current archive (Metal in the stock macOS build).

Linux Polaris already fails HIP via `unsupportedGfx("gfx803")`. Auto on Linux `gfx803` must take the Vulkan path too, not stop at `gpu_unsupported`.

## Acquisition

Clone the HIP on-demand pattern. Do not put Vulkan in the Tauri installer.

1. Pin both Vulkan assets in `packages/opencode/script/semif-server.lock.json` under `x86_64-pc-windows-msvc-vulkan` and `x86_64-unknown-linux-gnu-vulkan`.
2. CI `tauri-release` mirror job already iterates lock keys; extend the `*-hip` case to `*-vulkan`.
3. New `packages/opencode/src/semif/vulkan-runtime.ts`: download candidates (env mirror → published `semif-server-b11040` → ggml-org), sha256 verify, stage to `<data>/semif/runtime/vulkan-<sha12>/` with `.vulkan-runtime.json`.
4. `shouldFetch` is true when the binary is missing and (`requested === "vulkan"` or (`requested === "auto"` and HIP rejects this AMD GPU)). False for explicit `hip`/`cpu`/`cuda`, mixed GPUs, and non-host platforms.
5. `SemifPaths.resolveServerPath` / `resolveLibsPath` grow a staged Vulkan lookup identical to HIP (`NEXTCODE_SEMIF_VULKAN_LIBS_PATH` optional override).

Fetch happens inside the existing SemIf warmup/`start` path. Status uses `downloading` / `verifying` with Vulkan-specific UI keys, matching HIP fetch (no `gpu_unsupported` flash that implies “this GPU cannot run SemIf”).

## Offload

The sidecar currently spawns `llama-server` without `-ngl`. A Vulkan (or HIP) build with 0 GPU layers still infers on CPU. When the resolved backend is `hip` or `vulkan`, pass `-ngl 99`. CPU backend omits the flag.

This is required for the RX 580 to actually hold the GGUF in VRAM (~700 MB for LFM2-1.2B Q4; 4 GB and 8 GB RX 580 both fit at `contextSize` 2048).

## Runtime layout

`SemifRuntime.materialize` already colocates launcher + DLLs/SOs so ggml finds `ggml-vulkan` next to the executable. Stage the whole Vulkan archive through the existing extract filters (Windows: `llama-server.exe` + `*.dll`; Linux: `llama-server` + `*.so*`). Task 1 of the implementation plan lists archive members after download; if `vulkan-1.dll` / `libvulkan.so.1` ship in the zip they are staged automatically. If they do not, the process still spawns with `cwd` = runtime dir so Windows DLL search finds colocated ggml backends; Linux relies on the binary `$ORIGIN` RPATH/RUNPATH for those local SOs. The driver ICD loader is resolved from system paths (`vulkan-1.dll` / `libvulkan.so.1`), not from `cwd` or `extendEnv: true`. Do not set `LD_LIBRARY_PATH` and do not mutate PATH.

## Status and UI

New fallback reasons: `vulkan_download_failed`, `missing_vulkan_runtime` (ICD loader absent). Sidecar init failure remains `failed`, not a Vulkan-only reason.

Do not reuse `gpu_unsupported` as the terminal auto state for Polaris. That reason remains for explicit `hip` on a rejected GPU.

UI (`packages/app/src/components/semif-backend-status.ts`):

- `vulkan_active` — success dot, copy “Vulkan active”
- fetch in progress — warning dot, “Installing Vulkan runtime” / “Verifying Vulkan runtime”
- `vulkan_download_failed` — warning, CPU fallback copy
- `missing_vulkan_runtime` — warning, CPU fallback copy (ICD loader absent)
- sidecar spawn/init failure — `failed` (same as HIP)
- explicit `hip` + `gpu_unsupported` — unchanged designer copy

After `HttpApi` reason literals change, run `bun run generate` from `packages/client`. Do not edit `src/generated` by hand.

## Testing

Unit tests (no GPU required):

- `auto` + `amdGfx: "gfx803"` → `active: "vulkan"` once a fake Vulkan binary exists; `shouldFetch` true when it does not
- `auto` + `gfx1030` still HIP; Vulkan `shouldFetch` false
- `hip` + `gfx803` still `gpu_unsupported`; Vulkan `shouldFetch` false
- sidecar args include `-ngl 99` only when `nGpuLayers` is set
- lockfile pins vulkan targets; fetch-script `lockTargetKey(..., "vulkan")`
- i18n parity
- HttpApi schema includes `vulkan_download_failed` and `missing_vulkan_runtime`

Acceptance (optional, real RX 580): after warmup, `/semif/status` shows `backend: "vulkan"`, `backendFallback: false`, and `semif_decide` returns a chosen option. Not required to merge.

## Out of scope

- Bundling Vulkan in the NSIS/DMG to avoid the ~30 MB first download
- Auto-picking Vulkan when HIP download fails on a HIP-capable GPU
- Changing mixed-GPU `auto` (still CPU)
- Shipping Mesa/AMDVLK ICDs
- Quant/model changes
