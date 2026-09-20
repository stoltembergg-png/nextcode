// On-demand ROCm 10.0 Windows runtime staging for SemIf HIP.
//
// When the vendored HIP llama-server is present but the host lacks a ROCm/TheRock
// install, `ensure` downloads the pinned AMD wheels, verifies sha256 against
// `rocm-runtime.lock.json`, and stages bin/ + rocblas/library (+ hipblaslt/library)
// under `<data>/semif/runtime/rocm-10.0-<gfx>-<sha12>/`.

import { existsSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect"
import {
  deviceWheel,
  embeddedRocmLock,
  inspect,
  readRocmLock,
  rocmRuntimeComplete,
  runtimeStageKey,
  stageWheelsToDir,
  type RocmRuntimeLock,
  type StagedRocmLayout,
} from "../../script/fetch-rocm-runtime"
import { SemifAcquire, type DownloadPolicy, type Progress } from "./acquire"
import { hipPlatformSupported, readGpuInventory, vendoredBinaryExists, type BackendPreference } from "./backend"
import { resolveSupportedGfx, unsupportedGfx } from "./gfx"
import { SemifPaths } from "./paths"

const MARKER_NAME = ".rocm-runtime.json"
const MARKER_VERSION = 1

const Marker = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    gfx: Schema.String,
    rocmVersion: Schema.String,
    files: Schema.Array(Schema.Struct({ name: Schema.String, bytes: Schema.Number })),
  }),
)
const decodeMarker = Schema.decodeUnknownOption(Marker)

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const errorMessage = (cause: unknown): string =>
  cause instanceof RocmRuntimeError || cause instanceof SemifAcquire.AcquireError
    ? cause.reason
    : message(cause)

export class RocmRuntimeError extends Schema.TaggedErrorClass<RocmRuntimeError>()("SemifRocmRuntimeError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export interface EnsureInput {
  readonly policy: DownloadPolicy
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env?: Record<string, string | undefined>
  readonly onProgress?: (progress: Progress) => void
  readonly onPhase?: (phase: "downloading" | "verifying") => void
  readonly sources?: Readonly<Record<string, readonly string[]>>
  readonly maxAttempts?: number
}

export interface EnsureResult {
  readonly dir: string
  readonly binDir: string
  readonly rocblasLibraryDir: string
  readonly hipblasltLibraryDir?: string
  readonly gfx: string
  readonly acquired: boolean
}

export function rocmVendorSupported(platform = process.platform): boolean {
  return platform === "win32"
}

export function shouldFetch(input: {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env?: Record<string, string | undefined>
  readonly inventory?: ReturnType<typeof readGpuInventory>
  readonly gfx?: string
}): boolean {
  if (!rocmVendorSupported()) return false
  if (!hipPlatformSupported()) return false
  if (input.requested === "cpu" || input.requested === "cuda" || input.requested === "vulkan") return false
  const inventory = input.inventory ?? readGpuInventory()
  if (input.requested === "auto" && inventory.amd && inventory.nvidia) return false
  if (input.requested === "auto" && !inventory.amd) return false
  if (input.requested === "hip" && !inventory.amd) return false
  const env = input.env ?? process.env
  if (unsupportedGfx(env)) return false
  const gfx = input.gfx ?? resolveSupportedGfx(env)
  if (!gfx) return false
  if (!vendoredBinaryExists("hip", input.serverPath, env)) return false
  const dir = SemifPaths.rocmRuntimeDir(runtimeStageKey(embeddedRocmLock(), gfx))
  return !rocmRuntimeComplete(dir)
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
    return rocmRuntimeComplete(dir)
  })

const readStaged = Effect.fnUntraced(function* (gfx: string, lock: RocmRuntimeLock) {
  const fs = yield* FileSystem.FileSystem
  const dir = SemifPaths.rocmRuntimeDir(runtimeStageKey(lock, gfx))
  const markerPath = path.join(dir, MARKER_NAME)
  const marker = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""))
  const decoded = decodeMarker(marker)
  if (Option.isNone(decoded)) return undefined
  if (decoded.value.version !== MARKER_VERSION || decoded.value.gfx !== gfx) return undefined
  if (!(yield* isComplete(fs, dir, decoded.value.files))) return undefined
  const binDir = path.join(dir, "bin")
  const rocblasLibraryDir = path.join(dir, "rocblas", "library")
  const hipblasltLibraryDir = path.join(dir, "hipblaslt", "library")
  const hipblasltExists = yield* fs.stat(hipblasltLibraryDir).pipe(Effect.orElseSucceed(() => undefined))
  return {
    dir,
    binDir,
    rocblasLibraryDir,
    hipblasltLibraryDir: hipblasltExists?.type === "Directory" ? hipblasltLibraryDir : undefined,
    gfx,
    acquired: false,
  } satisfies EnsureResult
})

const downloadWheel = Effect.fnUntraced(function* (input: {
  readonly entry: { asset: string; url: string; bytes: number; sha256: string }
  readonly policy: DownloadPolicy
  readonly gfx: string
  readonly role: string
  readonly sources?: readonly string[]
  readonly maxAttempts?: number
  readonly onProgress?: (progress: Progress) => void
}) {
  const archive = path.join(SemifPaths.downloadsRoot(), input.entry.asset)
  const part = SemifPaths.partPath(input.entry.sha256)
  const candidates = input.sources ?? [input.entry.url]
  let lastError = `semif: no download source available for ${input.entry.asset}`
  for (const url of candidates) {
    const exit = yield* SemifAcquire.download({
      dest: archive,
      part,
      sha256: input.entry.sha256,
      expectedBytes: input.entry.bytes,
      maxAttempts: input.maxAttempts ?? 2,
      resolveUrl: () => Effect.succeed(url),
      onProgress: input.onProgress,
    }).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) return archive
    lastError = errorMessage(Cause.squash(exit.cause))
  }
  return yield* new RocmRuntimeError({
    reason: `semif: ROCm ${input.role} wheel download failed for ${input.gfx}: ${lastError}`,
  })
})

export const ensure = Effect.fn("SemifRocmRuntime.ensure")(function* (input: EnsureInput) {
  if (!rocmVendorSupported()) {
    return yield* new RocmRuntimeError({ reason: "semif: vendored ROCm runtime is only supported on Windows" })
  }
  const lock = yield* Effect.tryPromise({
    try: () => readRocmLock(),
    catch: (cause) => new RocmRuntimeError({ reason: `semif: cannot read ROCm lock: ${message(cause)}` }),
  })
  const env = input.env ?? process.env
  const unsupported = unsupportedGfx(env)
  if (unsupported) {
    return yield* new RocmRuntimeError({
      reason: `semif: AMD GPU gfx ${unsupported} is not supported by the pinned ROCm runtime matrix`,
    })
  }
  const gfx = resolveSupportedGfx(env)
  if (!gfx) {
    return yield* new RocmRuntimeError({
      reason: "semif: could not resolve a supported AMD GPU gfx target for ROCm runtime staging",
    })
  }
  const device = deviceWheel(lock, gfx)
  if (!device) {
    return yield* new RocmRuntimeError({ reason: `semif: ROCm device wheel is not pinned for ${gfx}` })
  }

  const staged = yield* readStaged(gfx, lock)
  if (staged) return staged

  if (input.policy !== "auto") {
    return yield* new RocmRuntimeError({
      reason: `semif: ROCm runtime is not staged and download=${input.policy}`,
    })
  }

  const fs = yield* FileSystem.FileSystem
  input.onPhase?.("downloading")
  const coreArchive = yield* downloadWheel({
    entry: lock.packages.core,
    policy: input.policy,
    gfx,
    role: "core",
    sources: input.sources?.core,
    maxAttempts: input.maxAttempts,
    onProgress: input.onProgress,
  })
  const librariesArchive = yield* downloadWheel({
    entry: lock.packages.libraries,
    policy: input.policy,
    gfx,
    role: "libraries",
    sources: input.sources?.libraries,
    maxAttempts: input.maxAttempts,
    onProgress: input.onProgress,
  })
  const deviceArchive = yield* downloadWheel({
    entry: device,
    policy: input.policy,
    gfx,
    role: "device",
    sources: input.sources?.[gfx] ?? input.sources?.device,
    maxAttempts: input.maxAttempts,
    onProgress: input.onProgress,
  })

  input.onPhase?.("verifying")
  for (const [archive, entry] of [
    [coreArchive, lock.packages.core],
    [librariesArchive, lock.packages.libraries],
    [deviceArchive, device],
  ] as const) {
    const actual = yield* Effect.tryPromise({
      try: () => inspect(archive),
      catch: (cause) => new RocmRuntimeError({ reason: `semif: cannot inspect ${entry.asset}: ${message(cause)}` }),
    })
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      return yield* new RocmRuntimeError({
        reason: `semif: ${entry.asset} sha256 mismatch (expected ${entry.sha256}, received ${actual.sha256})`,
      })
    }
  }

  const dir = SemifPaths.rocmRuntimeDir(runtimeStageKey(lock, gfx))
  const layout = yield* Effect.tryPromise({
    try: () =>
      stageWheelsToDir(
        [{ archive: coreArchive }, { archive: librariesArchive }, { archive: deviceArchive }],
        dir,
      ),
    catch: (cause) => new RocmRuntimeError({ reason: `semif: cannot stage ROCm runtime: ${message(cause)}` }),
  })

  const marker = {
    version: MARKER_VERSION,
    gfx,
    rocmVersion: lock.version,
    files: layout.files,
  }
  yield* fs
    .writeFileString(path.join(dir, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`)
    .pipe(
      Effect.mapError((cause) => new RocmRuntimeError({ reason: `semif: cannot write ROCm marker: ${cause.message}` })),
    )

  return {
    dir: layout.dir,
    binDir: layout.binDir,
    rocblasLibraryDir: layout.rocblasLibraryDir,
    hipblasltLibraryDir: layout.hipblasltLibraryDir,
    gfx,
    acquired: true,
  } satisfies EnsureResult
})

export function readStagedRuntime(
  env: Record<string, string | undefined> = process.env,
): StagedRocmLayout | undefined {
  const gfx = resolveSupportedGfx(env)
  if (!gfx) return undefined
  const dir = SemifPaths.rocmRuntimeDir(runtimeStageKey(embeddedRocmLock(), gfx))
  if (!rocmRuntimeComplete(dir)) return undefined
  const binDir = path.join(dir, "bin")
  const rocblasLibraryDir = path.join(dir, "rocblas", "library")
  const hipblasltLibraryDir = path.join(dir, "hipblaslt", "library")
  return {
    dir,
    binDir,
    rocblasLibraryDir,
    hipblasltLibraryDir: existsSync(hipblasltLibraryDir) ? hipblasltLibraryDir : undefined,
    files: [],
  }
}

export * as SemifRocmRuntime from "./rocm-runtime"
