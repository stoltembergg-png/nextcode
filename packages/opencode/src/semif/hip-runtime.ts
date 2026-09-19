// On-demand HIP llama-server runtime acquisition.
//
// The CPU bundle stays lean; when HIP is desired and the vendored HIP binary is
// absent, `ensureHipRuntime` downloads the pinned archive from the published
// mirror (or upstream), verifies sha256 against `semif-server.lock.json`, and
// stages launcher + HIP libs under `<data>/semif/runtime/hip-<sha12>/`.

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
import { hipPlatformSupported, readGpuInventory, vendoredBinaryExists, type BackendPreference } from "./backend"
import { SemifPaths } from "./paths"

const MARKER_NAME = ".hip-runtime.json"
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
  cause instanceof HipRuntimeError || cause instanceof SemifAcquire.AcquireError
    ? cause.reason
    : message(cause)

export class HipRuntimeError extends Schema.TaggedErrorClass<HipRuntimeError>()("SemifHipRuntimeError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export interface HipLock {
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
}

export interface EnsureResult {
  readonly serverPath: string
  readonly libsPath: string
  readonly acquired: boolean
}

export async function readHipLock(): Promise<HipLock | undefined> {
  const lock = await readLockfile()
  const baseTarget = hostTarget()
  const target = lockTargetKey(baseTarget, "hip")
  const entry = lock.targets[target]
  if (!entry) return undefined
  return { lock, baseTarget, target, entry }
}

export function shouldFetch(input: {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env?: Record<string, string | undefined>
  readonly inventory?: ReturnType<typeof readGpuInventory>
}): boolean {
  if (!hipPlatformSupported()) return false
  if (input.requested === "cpu" || input.requested === "cuda" || input.requested === "vulkan") return false
  const inventory = input.inventory ?? readGpuInventory()
  if (input.requested === "auto" && inventory.amd && inventory.nvidia) return false
  if (input.requested === "auto" && !inventory.amd) return false
  if (input.requested === "hip" && !inventory.amd) return false
  const env = input.env ?? process.env
  return !vendoredBinaryExists("hip", input.serverPath, env)
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

const readStaged = Effect.fnUntraced(function* (hip: HipLock) {
  const fs = yield* FileSystem.FileSystem
  const dir = SemifPaths.hipRuntimeDir(hip.entry.sha256)
  const markerPath = path.join(dir, MARKER_NAME)
  const marker = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""))
  const decoded = decodeMarker(marker)
  if (Option.isNone(decoded)) return undefined
  if (decoded.value.version !== MARKER_VERSION || decoded.value.sha256 !== hip.entry.sha256) return undefined
  if (!(yield* isComplete(fs, dir, decoded.value.files))) return undefined
  const serverName =
    decoded.value.files.find((file) => file.name.startsWith("llama-server"))?.name ?? SemifPaths.serverBinaryName()
  return { serverPath: path.join(dir, serverName), libsPath: dir, acquired: false } satisfies EnsureResult
})

export const ensure = Effect.fn("SemifHipRuntime.ensure")(function* (input: EnsureInput) {
  const hip = yield* Effect.tryPromise({
    try: () => readHipLock(),
    catch: (cause) => new HipRuntimeError({ reason: `semif: cannot read HIP lock: ${message(cause)}` }),
  })
  if (!hip) {
    return yield* new HipRuntimeError({ reason: "semif: HIP target is not pinned for this platform" })
  }

  const staged = yield* readStaged(hip)
  if (staged) return staged

  if (input.policy !== "auto") {
    return yield* new HipRuntimeError({
      reason: `semif: HIP runtime is not staged and download=${input.policy}`,
    })
  }

  const fs = yield* FileSystem.FileSystem
  const archive = path.join(SemifPaths.downloadsRoot(), hip.entry.asset)
  const part = SemifPaths.partPath(hip.entry.sha256)
  input.onPhase?.("downloading")
  const candidates = downloadCandidates(hip.lock, hip.target, hip.entry, input.env)
  let lastError = `semif: no download source available for ${hip.entry.asset}`
  let downloaded = false
  for (const url of candidates) {
    const exit = yield* SemifAcquire.download({
      dest: archive,
      part,
      sha256: hip.entry.sha256,
      expectedBytes: hip.entry.bytes,
      maxAttempts: 2,
      resolveUrl: () => Effect.succeed(url),
      onProgress: input.onProgress,
    }).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) {
      downloaded = true
      break
    }
    lastError = errorMessage(Cause.squash(exit.cause))
  }
  if (!downloaded) return yield* new HipRuntimeError({ reason: lastError })

  input.onPhase?.("verifying")
  const dir = SemifPaths.hipRuntimeDir(hip.entry.sha256)
  const stagedFiles = yield* Effect.tryPromise({
    try: () => stageExtractedToDir(archive, hip.entry.asset, hip.baseTarget, dir),
    catch: (cause) => new HipRuntimeError({ reason: `semif: cannot stage HIP runtime: ${message(cause)}` }),
  })

  const marker = {
    version: MARKER_VERSION,
    sha256: hip.entry.sha256,
    target: hip.target,
    files: stagedFiles.files,
  }
  yield* fs
    .writeFileString(path.join(dir, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`)
    .pipe(Effect.mapError((cause) => new HipRuntimeError({ reason: `semif: cannot write HIP marker: ${cause.message}` })))

  return { serverPath: stagedFiles.serverPath, libsPath: stagedFiles.libsPath, acquired: true } satisfies EnsureResult
})

export * as SemifHipRuntime from "./hip-runtime"
