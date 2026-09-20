#!/usr/bin/env bun
//
// Vendorizes the llama.cpp `llama-server` runtime used by SemIf so the binary
// always travels inside the Tauri bundle and is never downloaded at runtime.
//
//   upstream: https://github.com/ggml-org/llama.cpp/releases/download/<tag>/<asset>
//   mirror:   NEXTCODE_SEMIF_MIRROR (a URL to our own mirrored asset), tried first
//
// The archives carry `llama-server` plus its shared libraries (DLLs on Windows,
// dylibs on macOS, shared objects on Linux). All libraries are staged together
// so the loader can resolve them. Staging layout:
//
//   packages/desktop/src-tauri/binaries/llama-server-<triple>[.exe]  (Tauri externalBin, cpu)
//   packages/desktop/src-tauri/binaries/llama-server-<triple>-hip[.exe]  (hip variant)
//   packages/desktop/src-tauri/semif/<libs>                          (Tauri resources, cpu)
//   packages/desktop/src-tauri/semif-hip/<libs>                      (Tauri resources, hip)
//
// The lockfile is authoritative: bytes and sha256 are verified on every run, and
// the download falls back from the mirror to the upstream release.
//
// Usage:
//   bun script/fetch-semif-server.ts [--target <triple>] [--variant cpu|hip|cuda|vulkan] [--force] [--download-only]

import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import embeddedSemifServerLock from "./semif-server.lock.json" with { type: "json" }

export const UPSTREAM_BASE = "https://github.com/ggml-org/llama.cpp/releases/download"
export const MIRROR_REPO = "stoltembergg-png/nextcode"

export type SemifVariant = "cpu" | "hip" | "cuda" | "vulkan"

export interface TargetLock {
  asset: string
  bytes: number
  sha256: string
}

export interface Lockfile {
  tag: string
  targets: Record<string, TargetLock>
}

interface Marker {
  tag: string
  target: string
  variant: SemifVariant
  asset: string
  sha256: string
  staged: { path: string; bytes: number; sha256: string }[]
}

interface ExtractedFile {
  name: string
  read: () => Promise<Uint8Array>
}

const repo = path.resolve(import.meta.dir, "../../..")
const tauri = path.join(repo, "packages/desktop/src-tauri")
const binariesDir = path.join(tauri, "binaries")
const cacheDir = path.join(tauri, ".semif-cache")
export const lockPath = path.join(import.meta.dir, "semif-server.lock.json")

// Bundled opencode resolves `import.meta.dir` under `~BUN/root/...`, where the JSON
// file is not shipped. Import the lock so `bun build --compile` embeds it, then keep
// an immutable in-memory copy for runtime reads.
const cachedLockfile: Lockfile = JSON.parse(JSON.stringify(embeddedSemifServerLock)) as Lockfile

export function embeddedLockfile(): Lockfile {
  return cachedLockfile
}

export async function readLockfile(): Promise<Lockfile> {
  return embeddedLockfile()
}

export function archiveExtension(asset: string): ".zip" | ".tar.gz" {
  return asset.endsWith(".tar.gz") ? ".tar.gz" : ".zip"
}

export function publishedMirrorUrl(lock: Lockfile, target: string, entry: TargetLock): string {
  const ext = archiveExtension(entry.asset)
  const tag = `semif-server-${lock.tag}`
  return `https://github.com/${MIRROR_REPO}/releases/download/${tag}/semif-server-${lock.tag}-${target}${ext}`
}

export function downloadCandidates(
  lock: Lockfile,
  target: string,
  entry: TargetLock,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const mirror = env.NEXTCODE_SEMIF_MIRROR?.trim()
  const upstream = `${UPSTREAM_BASE}/${lock.tag}/${entry.asset}`
  const published = publishedMirrorUrl(lock, target, entry)
  return [mirror, published, upstream].filter((url): url is string => Boolean(url))
}

export const HOST_TARGETS: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
}

const VARIANT_SUFFIX: Record<Exclude<SemifVariant, "cpu">, string> = {
  hip: "-hip",
  cuda: "-cuda",
  vulkan: "-vulkan",
}

interface StageOptions {
  target?: string
  variant?: SemifVariant
  force?: boolean
  downloadOnly?: boolean
}

export function hostTarget(platform = process.platform, arch = process.arch): string {
  const target = HOST_TARGETS[`${platform}-${arch}`]
  if (!target) {
    throw new Error(
      `no llama-server target for ${platform}-${arch}; supported: ${Object.values(HOST_TARGETS).join(", ")}`,
    )
  }
  return target
}

export function lockTargetKey(baseTarget: string, variant: SemifVariant = "cpu"): string {
  if (variant === "cpu") return baseTarget
  return `${baseTarget}${VARIANT_SUFFIX[variant]}`
}

export function stagedServerName(baseTarget: string, variant: SemifVariant, isZip: boolean): string {
  const suffix = variant === "cpu" ? "" : VARIANT_SUFFIX[variant]
  return `llama-server-${baseTarget}${suffix}${isZip ? ".exe" : ""}`
}

export function stagedLibsDir(variant: SemifVariant): string {
  return path.join(tauri, variant === "cpu" ? "semif" : `semif-${variant}`)
}

export async function stageSemifServer(options: StageOptions = {}) {
  const lock = embeddedLockfile()
  const variant = options.variant ?? "cpu"
  const baseTarget = options.target ?? hostTarget()
  const target = lockTargetKey(baseTarget, variant)
  const entry = lock.targets[target]
  if (!entry) {
    throw new Error(`target ${target} is not pinned in ${path.relative(repo, lockPath)}`)
  }

  const isZip = entry.asset.endsWith(".zip")
  const executable = isZip ? "llama-server.exe" : "llama-server"
  const libsDir = stagedLibsDir(variant)
  const stagedServer = path.join(binariesDir, stagedServerName(baseTarget, variant, isZip))
  const markerPath = path.join(cacheDir, `${target}.json`)

  // `--download-only` must always materialize the archive, even when the target is
  // already staged: the caller may only want the durable copy for mirroring.
  if (!options.downloadOnly && !options.force && (await isUpToDate(markerPath, lock.tag, entry))) {
    console.log(`llama-server for ${target} is already staged: ${stagedServer}`)
    return {
      target,
      baseTarget,
      variant,
      stagedServer,
      libsDir,
      archive: path.join(cacheDir, entry.asset),
      skipped: true,
    }
  }

  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(binariesDir, { recursive: true })

  const archive = await ensureArchive(lock, target, entry)
  console.log(`archive verified: ${archive} (${entry.bytes} bytes)`)

  if (options.downloadOnly) {
    return { target, baseTarget, variant, stagedServer, libsDir, archive, skipped: false }
  }

  const files = await extract(archive, entry.asset, baseTarget)
  const binary = files.find((file) => file.name === executable)
  if (!binary) throw new Error(`archive ${entry.asset} does not contain ${executable}`)

  const libraries = files.filter((file) => file.name !== executable)
  rmSync(libsDir, { recursive: true, force: true })
  mkdirSync(libsDir, { recursive: true })

  const serverBytes = await binary.read()
  await Bun.write(stagedServer, serverBytes)
  const staged: Marker["staged"] = [
    { path: stagedServer, bytes: serverBytes.byteLength, sha256: hashBytes(serverBytes) },
  ]
  for (const library of libraries) {
    const destination = path.join(libsDir, library.name)
    const bytes = await library.read()
    await Bun.write(destination, bytes)
    staged.push({ path: destination, bytes: bytes.byteLength, sha256: hashBytes(bytes) })
  }

  if (!isZip) {
    const result = await $`chmod +x ${stagedServer}`.quiet().nothrow()
    if (result.exitCode !== 0) throw new Error(`could not mark ${stagedServer} executable`)
  }

  const marker: Marker = { tag: lock.tag, target, variant, asset: entry.asset, sha256: entry.sha256, staged }
  await Bun.write(markerPath, `${JSON.stringify(marker, null, 2)}\n`)

  console.log(`staged server: ${stagedServer} (${serverBytes.byteLength} bytes)`)
  console.log(`staged ${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} in ${libsDir}`)
  return { target, baseTarget, variant, stagedServer, libsDir, archive, skipped: false }
}

async function isUpToDate(markerPath: string, tag: string, entry: TargetLock): Promise<boolean> {
  const marker = (await Bun.file(markerPath)
    .json()
    .catch(() => undefined)) as Marker | undefined
  if (!marker || !Array.isArray(marker.staged) || marker.tag !== tag || marker.sha256 !== entry.sha256) return false
  return (
    await Promise.all(
      marker.staged.map(async (file) => {
        if (!file.sha256 || !existsSync(file.path) || statSync(file.path).size !== file.bytes) return false
        try {
          return (await inspect(file.path)).sha256 === file.sha256
        } catch {
          return false
        }
      }),
    )
  ).every(Boolean)
}

async function ensureArchive(lock: Lockfile, target: string, entry: TargetLock): Promise<string> {
  const archive = path.join(cacheDir, entry.asset)
  if (existsSync(archive)) {
    const cached = await inspect(archive)
    if (cached.bytes === entry.bytes && cached.sha256 === entry.sha256) return archive
    console.warn(`cached archive does not match the lock, re-downloading: ${archive}`)
    rmSync(archive, { force: true })
  }

  const candidates = downloadCandidates(lock, target, entry)

  let lastError = `no download source available for ${entry.asset}`
  for (const url of candidates) {
    console.log(`downloading ${url}`)
    const response = await fetch(url, { redirect: "follow" }).catch(() => undefined)
    if (!response?.ok) {
      lastError = `download failed (${response ? response.status : "network error"}): ${url}`
      console.warn(lastError)
      continue
    }
    await Bun.write(archive, response)
    const actual = await inspect(archive)
    if (actual.bytes === entry.bytes && actual.sha256 === entry.sha256) return archive
    lastError =
      `archive mismatch for ${entry.asset} from ${url}\n` +
      `  expected bytes=${entry.bytes} sha256=${entry.sha256}\n` +
      `  actual   bytes=${actual.bytes} sha256=${actual.sha256}`
    console.warn(lastError)
    rmSync(archive, { force: true })
  }
  throw new Error(lastError)
}

export async function inspect(file: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return { bytes: bytes.byteLength, sha256: hasher.digest("hex") }
}

function hashBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return hasher.digest("hex")
}

export function serverExecutableName(asset: string): string {
  return asset.endsWith(".zip") ? "llama-server.exe" : "llama-server"
}

export interface StagedRuntimeFiles {
  readonly serverPath: string
  readonly libsPath: string
  readonly files: { name: string; bytes: number }[]
}

export async function stageExtractedToDir(
  archive: string,
  asset: string,
  baseTarget: string,
  destDir: string,
): Promise<StagedRuntimeFiles> {
  const executable = serverExecutableName(asset)
  const extracted = await extract(archive, asset, baseTarget)
  const binary = extracted.find((file) => file.name === executable)
  if (!binary) throw new Error(`archive ${asset} does not contain ${executable}`)
  const libraries = extracted.filter((file) => file.name !== executable)
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  const files: { name: string; bytes: number }[] = []
  const serverPath = path.join(destDir, executable)
  const serverBytes = await binary.read()
  await Bun.write(serverPath, serverBytes)
  files.push({ name: executable, bytes: serverBytes.byteLength })
  for (const library of libraries) {
    const destination = path.join(destDir, library.name)
    const bytes = await library.read()
    await Bun.write(destination, bytes)
    files.push({ name: library.name, bytes: bytes.byteLength })
  }
  if (!asset.endsWith(".zip")) {
    const result = await $`chmod +x ${serverPath}`.quiet().nothrow()
    if (result.exitCode !== 0) throw new Error(`could not mark ${serverPath} executable`)
  }
  return { serverPath, libsPath: destDir, files }
}

export async function extract(archive: string, asset: string, baseTarget: string): Promise<ExtractedFile[]> {
  if (asset.endsWith(".zip")) return extractZip(archive)
  return extractTarGz(archive, baseTarget)
}

async function extractZip(archive: string): Promise<ExtractedFile[]> {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await Bun.file(archive).arrayBuffer())))
  const entries = await reader.getEntries()
  const files: ExtractedFile[] = []
  for (const entry of entries) {
    const getData = entry.getData
    if (typeof getData !== "function") continue
    const name = path.basename(entry.filename)
    if (!name.endsWith(".dll") && name !== "llama-server.exe") continue
    const data = await getData(new Uint8ArrayWriter())
    files.push({ name, read: async () => data })
  }
  await reader.close()
  return files
}

async function extractTarGz(archive: string, baseTarget: string): Promise<ExtractedFile[]> {
  const work = path.join(cacheDir, "extract")
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const result = await $`tar -xzf ${archive} -C ${work}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`tar failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
  }
  const roots = readdirSync(work).filter((name) => !name.startsWith("."))
  const root = roots.length === 1 ? path.join(work, roots[0]) : work
  const files: ExtractedFile[] = []
  for (const name of readdirSync(root)) {
    if (!neededLibrary(name, baseTarget)) continue
    const source = path.join(root, name)
    if (!statSync(source).isFile()) continue
    files.push({ name, read: async () => new Uint8Array(await Bun.file(source).arrayBuffer()) })
  }
  return files
}

/// The macOS archive versions its dylibs (`libllama.0.4.1.dylib`) and links every
/// consumer against the `.0` name (`@rpath/libllama.0.dylib`), shipping the
/// unversioned names only as symlinks. A load-command scan of the whole archive
/// shows every dependency resolves through the `.0` name, so staging those names
/// (plus the unversioned server impl) is enough and avoids duplicating each
/// library behind three names. Our staging dereferences the symlinks into real
/// files, because the bundle copy does not preserve links.
function neededLibrary(name: string, baseTarget: string): boolean {
  if (name === "llama-server") return true
  if (baseTarget.includes("darwin")) {
    return name === "libllama-server-impl.dylib" || name.endsWith(".0.dylib")
  }
  return name.endsWith(".so") || /\.so\.\d+$/.test(name)
}

function parseArgs(argv: string[]): StageOptions {
  const options: StageOptions = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--force") options.force = true
    else if (arg === "--download-only") options.downloadOnly = true
    else if (arg === "--target") options.target = argv[++index]
    else if (arg === "--variant") {
      const variant = argv[++index] as SemifVariant
      if (variant !== "cpu" && variant !== "hip" && variant !== "cuda" && variant !== "vulkan") {
        throw new Error(`unknown variant: ${variant}`)
      }
      options.variant = variant
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

if (import.meta.main) {
  // Top-level await keeps the process alive until staging finishes; a floating
  // promise lets Bun exit 0 mid-download.
  await stageSemifServer(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
