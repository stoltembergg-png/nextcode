// ROCm 10.0 Windows wheel lock and staging helpers for on-demand SemIf HIP runtime.
//
// Wheels are fetched directly from stable.repo.amd.com with sha256 verification.
// Staged layout beside the HIP llama-server runtime:
//   bin/               — amdhip64_7.dll, hipblas.dll, rocblas.dll, …
//   rocblas/library/   — Tensile kernels for the pinned gfx
//   hipblaslt/library/ — optional gfx-specific hipblaslt kernels

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import embeddedRocmRuntimeLock from "./rocm-runtime.lock.json" with { type: "json" }

export interface WheelLock {
  readonly asset: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

export interface RocmRuntimeLock {
  readonly version: string
  readonly platform: string
  readonly packages: {
    readonly core: WheelLock
    readonly libraries: WheelLock
  }
  readonly devices: Record<string, WheelLock>
}

export interface StagedRocmLayout {
  readonly dir: string
  readonly binDir: string
  readonly rocblasLibraryDir: string
  readonly hipblasltLibraryDir?: string
  readonly files: { name: string; bytes: number }[]
}

const cachedLockfile: RocmRuntimeLock = JSON.parse(JSON.stringify(embeddedRocmRuntimeLock)) as RocmRuntimeLock

export function embeddedRocmLock(): RocmRuntimeLock {
  return cachedLockfile
}

export async function readRocmLock(): Promise<RocmRuntimeLock> {
  return embeddedRocmLock()
}

export function supportedGfx(lock: RocmRuntimeLock = embeddedRocmLock()): readonly string[] {
  return Object.keys(lock.devices)
}

export function deviceWheel(lock: RocmRuntimeLock, gfx: string): WheelLock | undefined {
  return lock.devices[gfx]
}

export function runtimeStageKey(lock: RocmRuntimeLock, gfx: string): string {
  const device = deviceWheel(lock, gfx)
  if (!device) return `rocm-${lock.version}-${gfx}`
  const digest = `${lock.packages.core.sha256}:${lock.packages.libraries.sha256}:${device.sha256}`
  return `rocm-${lock.version}-${gfx}-${digest.slice(0, 12)}`
}

export async function inspect(file: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return { bytes: bytes.byteLength, sha256: hasher.digest("hex") }
}

const wheelPrefixes = ["_rocm_sdk_core", "_rocm_sdk_libraries"] as const

type WheelPrefix = (typeof wheelPrefixes)[number]

function stageTarget(prefix: WheelPrefix, entryName: string): string | undefined {
  const binPrefix = `${prefix}/bin/`
  if (!entryName.startsWith(binPrefix)) return undefined
  const relative = entryName.slice(binPrefix.length)
  if (!relative || relative.endsWith("/")) return undefined
  if (relative.startsWith("rocblas/library/")) return path.join("rocblas", "library", relative.slice("rocblas/library/".length))
  if (relative.startsWith("hipblaslt/library/")) {
    return path.join("hipblaslt", "library", relative.slice("hipblaslt/library/".length))
  }
  return path.join("bin", relative)
}

async function extractWheel(archive: string, destDir: string): Promise<{ name: string; bytes: number }[]> {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await Bun.file(archive).arrayBuffer())))
  const entries = await reader.getEntries()
  const files: { name: string; bytes: number }[] = []
  for (const entry of entries) {
    const getData = entry.getData
    if (typeof getData !== "function") continue
    const prefix = wheelPrefixes.find((candidate) => entry.filename.startsWith(`${candidate}/`))
    if (!prefix) continue
    const target = stageTarget(prefix, entry.filename)
    if (!target) continue
    const data = await getData(new Uint8ArrayWriter())
    const destination = path.join(destDir, target)
    mkdirSync(path.dirname(destination), { recursive: true })
    await Bun.write(destination, data)
    files.push({ name: target.replaceAll("\\", "/"), bytes: data.byteLength })
  }
  await reader.close()
  return files
}

function directoryFiles(dir: string, prefix = ""): { name: string; bytes: number }[] {
  if (!existsSync(dir)) return []
  const files: { name: string; bytes: number }[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const relative = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) {
      files.push(...directoryFiles(full, relative))
      continue
    }
    files.push({ name: relative.replaceAll("\\", "/"), bytes: statSync(full).size })
  }
  return files
}

export function rocmRuntimeComplete(dir: string): boolean {
  const required = [
    path.join(dir, "bin", "hipblas.dll"),
    path.join(dir, "bin", "rocblas.dll"),
    path.join(dir, "bin", "amdhip64_7.dll"),
    path.join(dir, "rocblas", "library"),
  ]
  return required.every((entry) => {
    if (!existsSync(entry)) return false
    if (entry.endsWith("library")) return statSync(entry).isDirectory() && readdirSync(entry).length > 0
    return statSync(entry).isFile()
  })
}

export async function stageWheelsToDir(
  wheels: ReadonlyArray<{ archive: string }>,
  destDir: string,
): Promise<StagedRocmLayout> {
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  for (const wheel of wheels) {
    await extractWheel(wheel.archive, destDir)
  }
  const files = directoryFiles(destDir)
  const binDir = path.join(destDir, "bin")
  const rocblasLibraryDir = path.join(destDir, "rocblas", "library")
  const hipblasltLibraryDir = path.join(destDir, "hipblaslt", "library")
  if (!rocmRuntimeComplete(destDir)) {
    throw new Error(`staged ROCm runtime is incomplete under ${destDir}`)
  }
  return {
    dir: destDir,
    binDir,
    rocblasLibraryDir,
    hipblasltLibraryDir: existsSync(hipblasltLibraryDir) ? hipblasltLibraryDir : undefined,
    files,
  }
}
