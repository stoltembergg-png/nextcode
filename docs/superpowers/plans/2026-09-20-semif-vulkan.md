# SemIf On-Demand Vulkan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `auto`, SemIf loads the local GGUF on AMD GPUs that HIP rejects (RX 580 / `gfx803`) via an on-demand llama.cpp Vulkan runtime, with no user config and no extra SDK/ROCm install.

**Architecture:** Keep HIP as the path for TheRock-supported gfx. When HIP rejects the GPU, fetch the pinned `b11040` Vulkan archive (same acquire/mirror/stage pattern as HIP), colocate launcher+libs, spawn `llama-server` with `-ngl 99`. Explicit `hip` on Polaris stays `gpu_unsupported`.

**Tech Stack:** Bun, Effect, vendored `llama-server` (ggml-org `b11040`), existing `SemifAcquire` / `SemifRuntime` / Tauri `tauri-release` mirror.

## Global Constraints

- Default branch baseline: `origin/dev` @ `6c989075c`.
- No user configuration required; `semif.backend` default remains `auto`.
- No ROCm, TheRock, Vulkan SDK, or apt packages as a setup step.
- Do not bundle Vulkan into the installer; on-demand download like HIP (~30 MB).
- Do not silently pivot explicit `hip` to Vulkan.
- Do not change mixed AMD+NVIDIA `auto` (still CPU + `mixed_gpus`).
- CUDA remains a stub (`unsupported_variant`).
- Platforms: `win32-x64` and `linux-x64` only.
- llama.cpp pin stays `b11040`; do not bump the tag in this work.
- After public Protocol/`HttpApi` changes, run `bun run generate` from `packages/client`. Never edit `src/generated` by hand.
- Tests run from `packages/opencode` or `packages/app`, never repo root.
- Typecheck with `bun typecheck` from the package directory.
- Conventional commits: `feat(semif): ...` / `test(semif): ...` / `chore(sdk): ...`.
- English UI copy lives in `packages/app/src/i18n/en.ts`; do not hardcode user-visible strings.
- Branch names for implementation: follow the agent’s required `cursor/...-6cba` template.

**Spec:** `docs/superpowers/specs/2026-09-20-semif-vulkan-design.md`

## File map

| File | Role |
|---|---|
| `packages/opencode/script/semif-server.lock.json` | Pin vulkan archive bytes + sha256 |
| `packages/opencode/script/fetch-semif-server.ts` | Already has `vulkan` variant suffix; lock + tests consume it |
| `.github/workflows/tauri-release.yml` | Mirror `*-vulkan` lock keys |
| `packages/opencode/src/semif/backend.ts` | Auto-select vulkan when HIP rejects GPU |
| `packages/opencode/src/semif/vulkan-runtime.ts` | Create: on-demand acquire/stage |
| `packages/opencode/src/semif/paths.ts` | Staged vulkan server/libs resolution |
| `packages/opencode/src/semif/hip-runtime.ts` | Unchanged HIP `shouldFetch` (still false on rejected gfx) |
| `packages/opencode/src/semif/service.ts` | `ensureVulkanRuntime` before sidecar spawn |
| `packages/opencode/src/semif/sidecar.ts` | `-ngl` when GPU backend |
| `packages/opencode/src/server/routes/instance/httpapi/groups/semif.ts` | `vulkan_download_failed` literal |
| `packages/app/src/components/semif-backend-status.ts` | Vulkan active / fetch UI |
| `packages/app/src/i18n/*.ts` | New keys; parity across `appLocales` |
| `packages/client` generated SDK | Regenerated from HttpApi |

---

### Task 1: Pin Vulkan archives and teach the mirror job

**Files:**
- Modify: `packages/opencode/script/semif-server.lock.json`
- Modify: `packages/opencode/test/script/fetch-semif-server.test.ts`
- Modify: `.github/workflows/tauri-release.yml`
- Test: `packages/opencode/test/script/fetch-semif-server.test.ts`

**Interfaces:**
- Consumes: `lockTargetKey(base, "vulkan")` already returns `${base}-vulkan`; `stagedServerName(..., "vulkan", isZip)` already returns `llama-server-<triple>-vulkan[.exe]`.
- Produces: lock entries `x86_64-pc-windows-msvc-vulkan` and `x86_64-unknown-linux-gnu-vulkan` with verified `asset`, `bytes`, `sha256`.

- [ ] **Step 1: Write the failing lock tests**

Add to `packages/opencode/test/script/fetch-semif-server.test.ts`:

```ts
test("suffixes vulkan lock keys and staging names", () => {
  expect(lockTargetKey("x86_64-pc-windows-msvc", "vulkan")).toBe("x86_64-pc-windows-msvc-vulkan")
  expect(stagedServerName("x86_64-pc-windows-msvc", "vulkan", true)).toBe(
    "llama-server-x86_64-pc-windows-msvc-vulkan.exe",
  )
  expect(stagedLibsDir("vulkan").replaceAll("\\", "/")).toMatch(/\/semif-vulkan$/)
})

test("embedded lockfile pins vulkan targets for windows and linux triples", () => {
  const lock = embeddedLockfile()
  const win = lock.targets["x86_64-pc-windows-msvc-vulkan"]
  const linux = lock.targets["x86_64-unknown-linux-gnu-vulkan"]
  expect(lock.tag).toBe("b11040")
  expect(win?.asset).toBe("llama-b11040-bin-win-vulkan-x64.zip")
  expect(linux?.asset).toBe("llama-b11040-bin-ubuntu-vulkan-x64.tar.gz")
  expect(win?.bytes).toBe(31821107)
  expect(linux?.bytes).toBe(30363623)
  expect(win?.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(linux?.sha256).toMatch(/^[0-9a-f]{64}$/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/script/fetch-semif-server.test.ts` from `packages/opencode`

Expected: FAIL — vulkan lock keys missing.

- [ ] **Step 3: Download, inspect, pin**

From `packages/opencode`:

```bash
bun -e '
import { inspect, UPSTREAM_BASE } from "./script/fetch-semif-server.ts"
import { mkdirSync } from "node:fs"
mkdirSync("/tmp/semif-vulkan-pin", { recursive: true })
const assets = [
  "llama-b11040-bin-win-vulkan-x64.zip",
  "llama-b11040-bin-ubuntu-vulkan-x64.tar.gz",
]
for (const asset of assets) {
  const dest = "/tmp/semif-vulkan-pin/" + asset
  const url = UPSTREAM_BASE + "/b11040/" + asset
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(url + " " + response.status)
  await Bun.write(dest, response)
  console.log(asset, await inspect(dest))
}
'
```

Expected GitHub `size` fields (must match `inspect().bytes`): Windows 31821107, Ubuntu 30363623. Write the printed `sha256` into the lockfile.

Add to `packages/opencode/script/semif-server.lock.json` `targets`:

```json
"x86_64-pc-windows-msvc-vulkan": {
  "asset": "llama-b11040-bin-win-vulkan-x64.zip",
  "bytes": 31821107,
  "sha256": "<inspect sha256>"
},
"x86_64-unknown-linux-gnu-vulkan": {
  "asset": "llama-b11040-bin-ubuntu-vulkan-x64.tar.gz",
  "bytes": 30363623,
  "sha256": "<inspect sha256>"
}
```

List archive members (confirm `llama-server` / `llama-server.exe` and `ggml-vulkan` / `ggml-vulkan.dll` exist). Note whether `vulkan-1.dll` or `libvulkan.so.1` is inside; do not add extra downloads if the driver loader is enough.

- [ ] **Step 4: Mirror job parses `*-vulkan`**

In `.github/workflows/tauri-release.yml` replace the variant case with:

```bash
VARIANT=cpu
BASE="$TARGET"
case "$TARGET" in
  *-hip) VARIANT=hip; BASE="${TARGET%-hip}" ;;
  *-vulkan) VARIANT=vulkan; BASE="${TARGET%-vulkan}" ;;
esac
```

- [ ] **Step 5: Re-run tests**

Run: `bun test test/script/fetch-semif-server.test.ts` from `packages/opencode`

Expected: PASS. Then `unzip -l` / `tar -tzf` on the cached archives for the member note.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/script/semif-server.lock.json packages/opencode/test/script/fetch-semif-server.test.ts .github/workflows/tauri-release.yml
git commit -m "feat(semif): pin llama.cpp b11040 vulkan archives"
```

---

### Task 2: Auto-select Vulkan when HIP rejects the GPU

**Files:**
- Modify: `packages/opencode/src/semif/backend.ts`
- Modify: `packages/opencode/test/semif/backend.test.ts`
- Modify: `packages/opencode/test/semif/gfx.test.ts`
- Test: `packages/opencode/test/semif/backend.test.ts`

**Interfaces:**
- Consumes: `amdGpuUnsupportedForWinHip`, `unsupportedGfx`, `vendoredBinaryExists`, `GpuInventory.amdGfx`.
- Produces: `amdHipUnsupported(inventory, env, platform?, arch?): boolean`. `resolveBackend` may return `active: "vulkan"`. New reasons stay unused until Task 4 except selection no longer uses `unsupported_variant` for `requested === "vulkan"`.

- [ ] **Step 1: Write failing selection tests**

In `packages/opencode/test/semif/backend.test.ts` add (use a temp HIP+Vulkan pair of fake launchers like the existing HIP tests):

```ts
test("auto on gfx803 selects vulkan when the vulkan launcher exists", () => {
  if (!hipPlatformSupported()) return
  const root = mkdtempSync(path.join(tmpdir(), "semif-backend-vulkan-auto-"))
  const triple = hostTarget()
  const isZip = process.platform === "win32"
  const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
  const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
  writeFileSync(cpu, "cpu")
  writeFileSync(vulkan, "vulkan")
  try {
    const status = resolveBackend({
      requested: "auto",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
      rocmRuntimePresent: false,
    })
    expect(status.active).toBe("vulkan")
    expect(status.fallback).toBe(false)
    expect(status.fallbackReason).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("explicit hip on gfx803 stays gpu_unsupported and does not activate vulkan", () => {
  if (!hipPlatformSupported()) return
  const root = mkdtempSync(path.join(tmpdir(), "semif-backend-hip-polar-"))
  const triple = hostTarget()
  const isZip = process.platform === "win32"
  const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
  const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
  writeFileSync(cpu, "cpu")
  writeFileSync(vulkan, "vulkan")
  try {
    const status = resolveBackend({
      requested: "hip",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
      rocmRuntimePresent: true,
    })
    expect(status.active).toBe("cpu")
    expect(status.fallbackReason).toBe("gpu_unsupported")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("auto on gfx1030 still prefers hip over vulkan", () => {
  if (!hipPlatformSupported()) return
  const root = mkdtempSync(path.join(tmpdir(), "semif-backend-hip-rdna-"))
  const triple = hostTarget()
  const isZip = process.platform === "win32"
  const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
  const hip = path.join(root, stagedServerName(triple, "hip", isZip))
  const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
  writeFileSync(cpu, "cpu")
  writeFileSync(hip, "hip")
  writeFileSync(vulkan, "vulkan")
  try {
    const status = resolveBackend({
      requested: "auto",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false, amdGfx: "gfx1030" },
      rocmRuntimePresent: true,
    })
    expect(status.active).toBe("hip")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

Also add a test that `requested: "vulkan"` with the fake vulkan launcher returns `active: "vulkan"` (today it returns `unsupported_variant`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/semif/backend.test.ts` from `packages/opencode`

Expected: FAIL — `unsupported_variant` / CPU for vulkan and gfx803 auto.

- [ ] **Step 3: Implement selection**

In `packages/opencode/src/semif/backend.ts`:

1. Import `unsupportedGfx` (already imported from `./gfx` on `origin/dev`).
2. Add:

```ts
export function amdHipUnsupported(
  inventory: GpuInventory,
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
  arch = process.arch,
): boolean {
  if (amdGpuUnsupportedForWinHip(inventory, platform, arch)) return true
  return Boolean(unsupportedGfx(env, platform))
}
```

3. Replace the `requested === "cuda" || requested === "vulkan"` stub so only `cuda` stays stubbed. `vulkan` calls a new `resolveVulkan` (mirror `resolveHip` without ROCm): platform check, AMD present, vendored vulkan binary, `vulkanFetching` / `vulkanDownloadFailed` flags on `ResolveInput`.
4. In `resolveBackend` for `auto`, after mixed-GPU and no-AMD checks, if `amdHipUnsupported(inventory, env)` then `return resolveVulkan({ requested: "auto", ... })` instead of `resolveHip`.
5. `inspect()`: if `active === "vulkan"` and the binary is missing, fallback `no_vendored_binary` (same as HIP inspect).

`ResolveInput` gains `vulkanDownloadFailed?: boolean` and `vulkanFetching?: boolean`. Add `vulkan_download_failed` to `BackendFallbackReason` in this task so tests can assert it later; `resolveVulkan` uses it like `hip_download_failed`.

- [ ] **Step 4: Run tests**

Run: `bun test test/semif/backend.test.ts test/semif/gfx.test.ts` from `packages/opencode`

Expected: PASS. Existing gfx test that `requested: "hip"` on gfx803 is `gpu_unsupported` must still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/backend.ts packages/opencode/test/semif/backend.test.ts
git commit -m "feat(semif): auto-select vulkan when HIP rejects AMD gfx"
```

---

### Task 3: On-demand Vulkan runtime acquire

**Files:**
- Create: `packages/opencode/src/semif/vulkan-runtime.ts`
- Create: `packages/opencode/test/semif/vulkan-runtime.test.ts`
- Modify: `packages/opencode/src/semif/paths.ts`
- Modify: `packages/opencode/test/semif/paths.test.ts` (only if it asserts HIP-only staged dirs)
- Test: `packages/opencode/test/semif/vulkan-runtime.test.ts`

**Interfaces:**
- Consumes: `downloadCandidates`, `stageExtractedToDir`, `SemifAcquire.download`, `lockTargetKey(hostTarget(), "vulkan")`, `amdHipUnsupported`.
- Produces:

```ts
export function shouldFetch(input: {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env?: Record<string, string | undefined>
  readonly inventory?: GpuInventory
}): boolean

export const ensure: (input: {
  readonly policy: DownloadPolicy
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env?: Record<string, string | undefined>
  readonly onProgress?: (progress: Progress) => void
  readonly onPhase?: (phase: "downloading" | "verifying") => void
  readonly sources?: readonly string[]
  readonly maxAttempts?: number
}) => Effect.Effect<EnsureResult, VulkanRuntimeError, FileSystem.FileSystem>
```

`EnsureResult` is `{ serverPath: string, libsPath: string, acquired: boolean }`.

Stage dir: `SemifPaths.vulkanRuntimeDir(sha256)` = `<data>/semif/runtime/vulkan-<sha12>/`. Marker `.vulkan-runtime.json` version 1.

- [ ] **Step 1: Write failing shouldFetch tests**

Create `packages/opencode/test/semif/vulkan-runtime.test.ts` modelled on `hip-runtime.test.ts`:

```ts
test("shouldFetch is true for auto when HIP rejects gfx803 and vulkan is not staged", () => {
  const triple = hostTarget()
  const isZip = process.platform === "win32"
  const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
  expect(
    shouldFetch({
      requested: "auto",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
    }),
  ).toBe(hipPlatformSupported())
})

test("shouldFetch is false for auto on gfx1030", () => {
  const triple = hostTarget()
  const isZip = process.platform === "win32"
  const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
  expect(
    shouldFetch({
      requested: "auto",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false, amdGfx: "gfx1030" },
    }),
  ).toBe(false)
})

test("shouldFetch is false for explicit hip even on gfx803", () => {
  const triple = hostTarget()
  const isZip = process.platform === "win32"
  const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
  expect(
    shouldFetch({
      requested: "hip",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
    }),
  ).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/semif/vulkan-runtime.test.ts` from `packages/opencode`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement paths + vulkan-runtime**

Copy `hip-runtime.ts` structure. Differences:

- `lockTargetKey(baseTarget, "vulkan")`
- `shouldFetch`: false unless `hipPlatformSupported()` (reuse; do not invent a second host set). False for `cpu` / `cuda` / `hip`. False for mixed GPUs. For `auto`, require AMD and `amdHipUnsupported`. For `vulkan`, require AMD. Then `!vendoredBinaryExists("vulkan", ...)`.
- Marker name `.vulkan-runtime.json`.
- `SemifPaths.vulkanRuntimeDir`, `pinnedVulkanSha256`, `resolveStagedVulkanServerPath` wired from `resolveServerPath` the same way HIP is (`if (variant === "vulkan")` after the HIP branch).
- `LIBS_VULKAN_ENV = "NEXTCODE_SEMIF_VULKAN_LIBS_PATH"` in `paths.ts`; `resolveLibsPath` uses it when `variant === "vulkan"`.

`ensure` with `policy !== "auto"` throws `semif: Vulkan runtime is not staged and download=${policy}`.

- [ ] **Step 4: Run tests**

Run: `bun test test/semif/vulkan-runtime.test.ts test/semif/paths.test.ts test/semif/hip-runtime.test.ts` from `packages/opencode`

Expected: PASS. HIP `shouldFetch` on gfx803 remains false.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/vulkan-runtime.ts packages/opencode/src/semif/paths.ts packages/opencode/test/semif/vulkan-runtime.test.ts packages/opencode/test/semif/paths.test.ts
git commit -m "feat(semif): acquire vulkan llama-server runtime on demand"
```

---

### Task 4: Service warmup fetches Vulkan and reports status

**Files:**
- Modify: `packages/opencode/src/semif/service.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/semif.ts`
- Modify: `packages/opencode/test/server/httpapi-semif.test.ts`
- Modify: `packages/opencode/test/semif/service-state.test.ts` if it snapshots fallback reasons
- Test: `packages/opencode/test/server/httpapi-semif.test.ts`

**Interfaces:**
- Consumes: `SemifVulkanRuntime.shouldFetch` / `ensure`, `resolveBackend` vulkan flags.
- Produces: process state fields `vulkanFetching` and `vulkanDownloadFailed`; `acquireHandle` calls `ensureVulkanRuntime` when HIP is skipped.

- [ ] **Step 1: Write failing schema test**

In `packages/opencode/test/server/httpapi-semif.test.ts`, add `"vulkan_download_failed"` next to `"gpu_unsupported"` in the expected reason list.

- [ ] **Step 2: Run to see fail**

Run: `bun test test/server/httpapi-semif.test.ts` from `packages/opencode`

Expected: FAIL — literal not in schema.

- [ ] **Step 3: Wire service**

In `service.ts` `State`, add `vulkanFetching?: boolean` and `vulkanDownloadFailed?: boolean`. Pass both into `resolveBackend` / snapshot like HIP.

Add `ensureVulkanRuntime` next to `ensureHipRuntime`:

- If `amdHipUnsupported` is false and `requested !== "vulkan"`, return.
- If `!SemifVulkanRuntime.shouldFetch(...)`, return.
- Set `status: "downloading"`, `vulkanFetching: true`.
- `SemifVulkanRuntime.ensure({ policy: loaded.download, requested: loaded.resolved.backend, ... })`.
- On failure with `download === "auto"`, set `vulkanDownloadFailed: true` (do not set `hipDownloadFailed`).
- Do not fetch HIP/ROCm when `amdHipUnsupported` (already gated).

In `acquireHandle`, order:

1. `ensureVulkanRuntime` (no-op on HIP-capable auto)
2. `ensureHipRuntime` (no-op on gfx803)
3. `ensureRocmRuntime` (already gated)
4. model + materialize + sidecar

`load` must resolve `serverPath` / `libsPath` with `variant: loaded.backend.active` so a staged vulkan dir is visible after fetch.

- [ ] **Step 4: HttpApi + generate**

Add `"vulkan_download_failed"` to `backendFallbackReason` in `groups/semif.ts`.

From `packages/client`: `bun run generate`

From `packages/opencode`: `bun test test/server/httpapi-semif.test.ts`

From `packages/opencode`: `bun typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/service.ts packages/opencode/src/server/routes/instance/httpapi/groups/semif.ts packages/opencode/test/server/httpapi-semif.test.ts packages/sdk packages/client
git commit -m "feat(semif): fetch vulkan runtime during warmup without user config"
```

---

### Task 5: Offload GGUF layers to the GPU (`-ngl 99`)

**Files:**
- Modify: `packages/opencode/src/semif/sidecar.ts`
- Modify: `packages/opencode/test/semif/sidecar.test.ts`
- Modify: `packages/opencode/src/semif/service.ts` (pass `nGpuLayers`)
- Test: `packages/opencode/test/semif/sidecar.test.ts`

**Interfaces:**
- Consumes: `SidecarConfig`
- Produces: `sidecarArgs(config, port): string[]`; `SidecarConfig.nGpuLayers?: number`

- [ ] **Step 1: Write failing argv tests**

Export `sidecarArgs` from `sidecar.ts` and test:

```ts
test("cpu sidecar omits ngl", () => {
  expect(sidecarArgs({
    host: "127.0.0.1",
    port: 8817,
    threads: 4,
    contextSize: 2048,
    loadTimeoutMs: 1000,
    serverPath: "/llama-server",
    modelPath: "/model.gguf",
  }, 8817).includes("-ngl")).toBe(false)
})

test("gpu sidecar offloads all layers", () => {
  const args = sidecarArgs({
    host: "127.0.0.1",
    port: 8817,
    threads: 4,
    contextSize: 2048,
    loadTimeoutMs: 1000,
    serverPath: "/llama-server",
    modelPath: "/model.gguf",
    nGpuLayers: 99,
  }, 8817)
  const index = args.indexOf("-ngl")
  expect(index).toBeGreaterThanOrEqual(0)
  expect(args[index + 1]).toBe("99")
})
```

- [ ] **Step 2: Run to fail**

Run: `bun test test/semif/sidecar.test.ts` from `packages/opencode`

Expected: FAIL — `sidecarArgs` / `nGpuLayers` missing.

- [ ] **Step 3: Implement**

```ts
export interface SidecarConfig {
  readonly host: string
  readonly port: number
  readonly threads: number
  readonly contextSize: number
  readonly loadTimeoutMs: number
  readonly serverPath: string
  readonly modelPath: string
  readonly env?: Record<string, string>
  readonly nGpuLayers?: number
}

export function sidecarArgs(config: SidecarConfig, port: number): string[] {
  const args = [
    "-m",
    config.modelPath,
    "--host",
    config.host,
    "--port",
    String(port),
    "--threads",
    String(config.threads),
    "-c",
    String(config.contextSize),
    "--no-webui",
    "--parallel",
    "2",
  ]
  if (config.nGpuLayers !== undefined) {
    args.push("-ngl", String(config.nGpuLayers))
  }
  return args
}
```

`command` uses `sidecarArgs(config, port)`.

In `service.ts` `SemifSidecar.ensure`, set `nGpuLayers: loaded.backend.active === "hip" || loaded.backend.active === "vulkan" ? 99 : undefined`.

- [ ] **Step 4: Run tests**

Run: `bun test test/semif/sidecar.test.ts` from `packages/opencode`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/sidecar.ts packages/opencode/src/semif/service.ts packages/opencode/test/semif/sidecar.test.ts
git commit -m "feat(semif): offload local model layers on HIP and Vulkan"
```

---

### Task 6: Status UI and i18n

**Files:**
- Modify: `packages/app/src/components/semif-backend-status.ts`
- Modify: `packages/app/src/components/semif-backend-status.test.ts`
- Modify: `packages/app/src/i18n/en.ts` (source copy)
- Modify: every locale in `packages/app/src/i18n/parity.test.ts` `appLocales` plus `br.ts` (parity includes `br`)
- Test: `packages/app/src/components/semif-backend-status.test.ts` and `packages/app/src/i18n/parity.test.ts`

**Interfaces:**
- Consumes: `SemifStatus.backend === "vulkan"`, `backendRequested`, download status.
- Produces: display state `vulkan_active` | vulkan fetch-in-progress; i18n keys below.

English source (`en.ts`) — keep HIP strings byte-for-byte; add:

```
"semif.backend.vulkan_active": "Vulkan active"
"semif.backend.vulkan_downloading": "Installing Vulkan runtime"
"semif.backend.vulkan_verifying": "Verifying Vulkan runtime"
"semif.state.downloading_vulkan_runtime": "Installing Vulkan runtime"
"semif.state.verifying_vulkan_runtime": "Verifying Vulkan runtime"
"semif.backend.fallback.vulkan_download_failed": "Using CPU — Vulkan runtime download failed"
```

`br.ts` (pt-BR):

```
"semif.backend.vulkan_active": "Vulkan ativo"
"semif.backend.vulkan_downloading": "Instalando runtime Vulkan"
"semif.backend.vulkan_verifying": "Verificando runtime Vulkan"
"semif.state.downloading_vulkan_runtime": "Instalando runtime Vulkan"
"semif.state.verifying_vulkan_runtime": "Verificando runtime Vulkan"
"semif.backend.fallback.vulkan_download_failed": "Usando CPU — falha ao baixar o runtime Vulkan"
```

Other locales: copy the English values so `parity.test.ts` key sets match. Do not invent extra English keys.

- [ ] **Step 1: Write failing UI tests**

```ts
test("reports vulkan active", () => {
  expect(
    semifBackendDisplayState({
      ...base(),
      backend: "vulkan",
      backendRequested: "auto",
      backendFallback: false,
    }),
  ).toBe("vulkan_active")
  expect(semifBackendMessageKey({ ...base(), backend: "vulkan", backendFallback: false })).toBe(
    "semif.backend.vulkan_active",
  )
  expect(semifBackendDotClass("vulkan_active")).toBe("bg-icon-success-base")
})

test("detects vulkan fetch in progress", () => {
  expect(
    semifVulkanFetchInProgress({
      ...base(),
      status: "downloading",
      backend: "cpu",
      backendRequested: "auto",
      backendFallback: false,
    }),
  ).toBe(true)
})

test("gpu_unsupported hip fetch is still skipped", () => {
  expect(
    semifHipFetchInProgress({
      ...base(),
      status: "downloading",
      backendFallbackReason: "gpu_unsupported",
      backendRequested: "hip",
    }),
  ).toBe(false)
})
```

`semifVulkanFetchInProgress` mirrors HIP: downloading/verifying, requested `auto` or `vulkan`, reason is not `gpu_unsupported`, not already `vulkan` without fallback. Treat missing binary / fetching flags like HIP (`no_vendored_binary` or no fallback reason).

- [ ] **Step 2: Run to fail**

Run: `bun test src/components/semif-backend-status.test.ts` from `packages/app`

Expected: FAIL.

- [ ] **Step 3: Implement display + locales**

Extend `SemifBackendDisplayState` with `"vulkan_active" | "vulkan_fetch_in_progress"`. Success dot for `vulkan_active`. Warning dot for fetch. `semifLifecycleStatusKey` returns vulkan verifying/downloading keys during fetch.

Add the six keys to `en.ts`, `br.ts`, and every `appLocales` file.

- [ ] **Step 4: Run tests**

Run from `packages/app`:

```
bun test src/components/semif-backend-status.test.ts src/i18n/parity.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/semif-backend-status.ts packages/app/src/components/semif-backend-status.test.ts packages/app/src/i18n
git commit -m "feat(app): show SemIf Vulkan backend status"
```

---

### Task 7: Package typecheck and spec note

**Files:**
- Modify: `specs/semif-plugin.md` section 9 (one short paragraph: Vulkan on-demand for HIP-rejected AMD, `-ngl 99`, no user config)
- Test: typecheck + existing semif tests

- [ ] **Step 1: Typecheck**

```
bun typecheck
```

from `packages/opencode` and `packages/app`.

- [ ] **Step 2: Regression tests**

From `packages/opencode`: `bun test test/semif test/script/fetch-semif-server.test.ts test/server/httpapi-semif.test.ts`

From `packages/app`: `bun test src/components/semif-backend-status.test.ts src/i18n/parity.test.ts`

Expected: all PASS.

- [ ] **Step 3: Spec note + commit**

In `specs/semif-plugin.md` section 9, after the backend bullet, add that `auto` uses HIP when the gfx is in the TheRock/ROCm matrix and otherwise fetches the pinned Vulkan `llama-server` on Windows/Ubuntu x64; sidecar passes `-ngl 99` for those backends; Polaris (RX 580) is the motivating case; explicit `hip` still reports `gpu_unsupported`.

```bash
git add specs/semif-plugin.md
git commit -m "docs(semif): document autonomous vulkan fallback for unsupported AMD"
```

---

## Self-review

- Spec coverage: pin/mirror, auto selection, acquire, service, `-ngl`, UI/i18n, generate, tests — each has a task.
- Placeholders: lockfile sha256 is produced by `inspect()` in Task 1, not left as a later TODO.
- Types: `EnsureResult`, `shouldFetch`, `amdHipUnsupported`, `sidecarArgs`, `nGpuLayers`, `vulkan_download_failed` are named consistently across tasks.
- Mixed GPUs, CUDA stub, installer size, and explicit `hip` honesty are unchanged on purpose.
