// Path resolution for the SemIf model and server. There are no author-machine
// paths here: everything derives from `Global.Path` or from configuration and
// environment supplied at runtime.
//
// Layout decisions (global, one model per machine):
//   model      <data>/semif/models/<sha256 first 12>/<filename>
//   runtime    <data>/semif/runtime/<content key>/(launcher + libs)
//   partials   <cache>/semif/downloads/<sha256>.part
//
// The model directory is keyed by the first 12 hex characters of the pinned
// sha256, so a different model revision never collides with the current one and
// stale downloads can be garbage-collected by prefix. Partial downloads live in
// cache (not data) because they are disposable and resume-able. The runtime
// directory is keyed by the launcher/libraries content so a new vendored build
// gets a fresh directory and the old one can be garbage-collected.

import { existsSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"
import type { BackendVariant } from "./backend"

export const SERVER_ENV = "NEXTCODE_SEMIF_SERVER_PATH"
export const SERVER_ENV_FALLBACK = "SEMIF_SERVER_PATH"
export const LIBS_ENV = "NEXTCODE_SEMIF_LIBS_PATH"
export const LIBS_HIP_ENV = "NEXTCODE_SEMIF_HIP_LIBS_PATH"

export function modelsRoot(): string {
  return path.join(Global.Path.data, "semif", "models")
}

export function modelDir(sha256: string): string {
  return path.join(modelsRoot(), sha256.slice(0, 12))
}

export function modelPath(sha256: string, filename: string): string {
  return path.join(modelDir(sha256), filename)
}

export function downloadsRoot(): string {
  return path.join(Global.Path.cache, "semif", "downloads")
}

export function partPath(sha256: string): string {
  return path.join(downloadsRoot(), `${sha256}.part`)
}

export function runtimeRoot(): string {
  return path.join(Global.Path.data, "semif", "runtime")
}

export function runtimeDir(key: string): string {
  return path.join(runtimeRoot(), key)
}

export function serverBinaryName(): string {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server"
}

export interface ModelPathInput {
  readonly configPath?: string
  readonly sha256: string
  readonly filename: string
}

// Precedence: explicit config path > registry path derived from the pinned hash.
export function resolveModelPath(input: ModelPathInput): string {
  const configured = readString(input.configPath)
  if (configured) return configured
  return modelPath(input.sha256, input.filename)
}

export interface ServerPathInput {
  readonly configPath?: string
  readonly env?: Record<string, string | undefined>
  readonly devFallback?: string
  readonly variant?: BackendVariant
}

// Precedence: explicit config path > environment > a dev-only sibling of the
// running executable, but only when that sibling actually exists. Absence is not
// an error; callers surface a dedicated error when the server is actually needed.
export function resolveServerPath(input: ServerPathInput = {}): string | undefined {
  const env = input.env ?? process.env
  const variant = input.variant ?? "cpu"
  const configured = readString(input.configPath) ?? readString(env[SERVER_ENV]) ?? readString(env[SERVER_ENV_FALLBACK])
  if (configured) return serverPathForVariant(configured, variant)
  const dev = input.devFallback ?? defaultDevServerPath(variant)
  if (dev && existsSync(dev)) return dev
  return undefined
}

function serverPathForVariant(serverPath: string, variant: BackendVariant): string {
  if (variant === "cpu") return serverPath
  const ext = path.extname(serverPath)
  const base = ext ? serverPath.slice(0, -ext.length) : serverPath
  const hip = `${base}-hip${ext}`
  if (variant === "hip" && existsSync(hip)) return hip
  const triple = hostTarget()
  const named = path.join(path.dirname(serverPath), stagedServerName(triple, variant, ext === ".exe"))
  if (existsSync(named)) return named
  return serverPath
}

function defaultDevServerPath(variant: BackendVariant): string {
  // An unbundled build often stages the runtime next to the current executable.
  // Production shells pass `NEXTCODE_SEMIF_SERVER_PATH` instead, which wins above.
  const triple = hostTarget()
  const isZip = process.platform === "win32"
  return path.join(path.dirname(process.execPath), stagedServerName(triple, variant, isZip))
}

// Directory holding the launcher's shared libraries, supplied by the desktop
// shell as the `semif` resource. When absent the sidecar spawns the resolved
// binary in place (the unbundled/dev path).
export function resolveLibsPath(
  env: Record<string, string | undefined> = process.env,
  variant: BackendVariant = "cpu",
): string | undefined {
  if (variant === "hip") return readString(env[LIBS_HIP_ENV]) ?? readString(env[LIBS_ENV])
  return readString(env[LIBS_ENV])
}

function readString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export * as SemifPaths from "./paths"
