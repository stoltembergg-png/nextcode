// On-demand Vulkan llama-server runtime acquisition.
//
// The CPU bundle stays lean; when Vulkan is desired and the vendored Vulkan
// binary is absent, `ensure` downloads the pinned archive from the published
// mirror (or upstream), verifies sha256 against `semif-server.lock.json`, and
// stages launcher + Vulkan libs under `<data>/semif/runtime/vulkan-<sha12>/`.

import path from "node:path"
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect"
import {
  downloadCandidates,
  hostTarget,
  lockTargetKey,
  readLockfile,
  stageExtractedToDir,
  type Lockfile,
  type TargetLock,
} from "../../script/fetch-semif-server"
import { SemifAcquire, type DownloadPolicy, type Progress } from "./acquire"
import {
  amdHipUnsupported,
  hipPlatformSupported,
  readGpuInventory,
  vendoredBinaryExists,
  type BackendPreference,
  type GpuInventory,
} from "./backend"
import { SemifPaths } from "./paths"

const MARKER_NAME = ".vulkan-runtime.json"
const MARKER_VERSION = 1

const Marker = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    sha256: Schema.String,
    target: Schema.String,
    files: Schema.Array(Schema.Struct({ name: Schema.String, bytes: Schema.Number })),
  }),
)
const decodeMarker = Schema.decodeUnknownOption(Marker)

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const errorMessage = (cause: unknown): string =>
  cause instanceof VulkanRuntimeError || cause instanceof SemifAcquire.AcquireError
    ? cause.reason
    : message(cause)

export class VulkanRuntimeError extends Schema.TaggedErrorClass<VulkanRuntimeError>()("SemifVulkanRuntimeError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export interface VulkanLock {
  readonly lock: Lockfile
  readonly baseTarget: string
  readonly target: string
  readonly entry: TargetLock
}

export interface EnsureInput {
  readonly policy: DownloadPolicy
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env?: Record<string, string | undefined>
  readonly onProgress?: (progress: Progress) => void
  readonly onPhase?: (phase: "downloading" | "verifying") => void
  // Test-only: pin download sources and attempts so acceptance tests do not hit upstream mirrors.
  readonly sources?: readonly string[]
  readonly maxAttempts?: number
}

export interface EnsureResult {
  readonly serverPath: string
  readonly libsPath: string
  readonly acquired: boolean
}

export async function readVulkanLock(): Promise<VulkanLock | undefined> {
  const lock = await readLockfile()
  const baseTarget = hostTarget()
  const target = lockTargetKey(baseTarget, "vulkan")
  const entry = lock.targets[target]
  if (!entry) return undefined
  return { lock, baseTarget, target, entry }
}

export function shouldFetch(input: {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env?: Record<string, string | undefined>
  readonly inventory?: GpuInventory
}): boolean {
  if (!hipPlatformSupported()) return false
  if (input.requested === "cpu" || input.requested === "cuda" || input.requested === "hip") return false
  const inventory = input.inventory ?? readGpuInventory()
  if (inventory.amd && inventory.nvidia) return false
  const env = input.env ?? process.env
  if (input.requested === "auto") {
    if (!inventory.amd) return false
    if (!amdHipUnsupported(inventory, env)) return false
  }
  if (input.requested === "vulkan" && !inventory.amd) return false
  return !vendoredBinaryExists("vulkan", input.serverPath, env)
}

const isComplete = (
  fs: FileSystem.FileSystem,
  dir: string,
  files: ReadonlyArray<{ name: string; bytes: number }>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const file of files) {
      const info = yield* fs.stat(path.join(dir, file.name)).pipe(Effect.orElseSucceed(() => undefined))
      if (!info || info.type !== "File" || Number(info.size) !== file.bytes) return false
    }
    return true
  })

const readStaged = Effect.fnUntraced(function* (vulkan: VulkanLock) {
  const fs = yield* FileSystem.FileSystem
  const dir = SemifPaths.vulkanRuntimeDir(vulkan.entry.sha256)
  const markerPath = path.join(dir, MARKER_NAME)
  const marker = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""))
  const decoded = decodeMarker(marker)
  if (Option.isNone(decoded)) return undefined
  if (decoded.value.version !== MARKER_VERSION || decoded.value.sha256 !== vulkan.entry.sha256) return undefined
  if (!(yield* isComplete(fs, dir, decoded.value.files))) return undefined
  const serverName =
    decoded.value.files.find((file) => file.name.startsWith("llama-server"))?.name ?? SemifPaths.serverBinaryName()
  return { serverPath: path.join(dir, serverName), libsPath: dir, acquired: false } satisfies EnsureResult
})

export const ensure = Effect.fn("SemifVulkanRuntime.ensure")(function* (input: EnsureInput) {
  const vulkan = yield* Effect.tryPromise({
    try: () => readVulkanLock(),
    catch: (cause) => new VulkanRuntimeError({ reason: `semif: cannot read Vulkan lock: ${message(cause)}` }),
  })
  if (!vulkan) {
    return yield* new VulkanRuntimeError({ reason: "semif: Vulkan target is not pinned for this platform" })
  }

  const staged = yield* readStaged(vulkan)
  if (staged) return staged

  if (input.policy !== "auto") {
    return yield* new VulkanRuntimeError({
      reason: `semif: Vulkan runtime is not staged and download=${input.policy}`,
    })
  }

  const fs = yield* FileSystem.FileSystem
  const archive = path.join(SemifPaths.downloadsRoot(), vulkan.entry.asset)
  const part = SemifPaths.partPath(vulkan.entry.sha256)
  input.onPhase?.("downloading")
  const candidates = input.sources ?? downloadCandidates(vulkan.lock, vulkan.target, vulkan.entry, input.env)
  let lastError = `semif: no download source available for ${vulkan.entry.asset}`
  let downloaded = false
  for (const url of candidates) {
    const exit = yield* SemifAcquire.download({
      dest: archive,
      part,
      sha256: vulkan.entry.sha256,
      expectedBytes: vulkan.entry.bytes,
      maxAttempts: input.maxAttempts ?? 2,
      resolveUrl: () => Effect.succeed(url),
      onProgress: input.onProgress,
    }).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) {
      downloaded = true
      break
    }
    lastError = errorMessage(Cause.squash(exit.cause))
  }
  if (!downloaded) return yield* new VulkanRuntimeError({ reason: lastError })

  input.onPhase?.("verifying")
  const dir = SemifPaths.vulkanRuntimeDir(vulkan.entry.sha256)
  const stagedFiles = yield* Effect.tryPromise({
    try: () => stageExtractedToDir(archive, vulkan.entry.asset, vulkan.baseTarget, dir),
    catch: (cause) => new VulkanRuntimeError({ reason: `semif: cannot stage Vulkan runtime: ${message(cause)}` }),
  })

  const marker = {
    version: MARKER_VERSION,
    sha256: vulkan.entry.sha256,
    target: vulkan.target,
    files: stagedFiles.files,
  }
  yield* fs
    .writeFileString(path.join(dir, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`)
    .pipe(
      Effect.mapError((cause) => new VulkanRuntimeError({ reason: `semif: cannot write Vulkan marker: ${cause.message}` })),
    )

  return { serverPath: stagedFiles.serverPath, libsPath: stagedFiles.libsPath, acquired: true } satisfies EnsureResult
})

export * as SemifVulkanRuntime from "./vulkan-runtime"
