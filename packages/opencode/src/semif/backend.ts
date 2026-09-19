// Backend variant selection for the vendored llama-server runtime.
//
// Variants are exclusive (`cpu | cuda | hip | vulkan`). `auto` picks one on
// supported platforms; mixed AMD+NVIDIA hosts require an explicit backend. CPU
// fallback is always visible in status and logs — never silent.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { hostTarget } from "../../script/fetch-semif-server"
import { SemifPaths } from "./paths"

export type BackendVariant = "cpu" | "cuda" | "hip" | "vulkan"
export type BackendPreference = "auto" | BackendVariant

export type BackendFallbackReason =
  | "manual_cpu"
  | "platform_unsupported"
  | "mixed_gpus"
  | "no_amd_gpu"
  | "missing_rocm_runtime"
  | "no_vendored_binary"
  | "hip_download_failed"
  | "unsupported_variant"

export interface GpuInventory {
  readonly amd: boolean
  readonly nvidia: boolean
}

export interface BackendStatus {
  readonly requested: BackendPreference
  readonly active: BackendVariant
  readonly fallback: boolean
  readonly fallbackReason?: BackendFallbackReason
  readonly message?: string
  readonly systemRuntimeMissing: boolean
  readonly amdGpu: boolean
  readonly nvidiaGpu: boolean
}

export interface ResolveInput {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly libsPath?: string
  readonly env?: Record<string, string | undefined>
  readonly inventory?: GpuInventory
  readonly rocmRuntimePresent?: boolean
  readonly hipDownloadFailed?: boolean
}

const HIP_HOSTS = new Set(["win32-x64", "linux-x64"])

// Linux ggml-hip links against the system ROCm stack. The vendored archive omits
// these libraries and expects them from /opt/rocm or the loader search path.
export const ROCM_RUNTIME_LIBS_LINUX = ["libhipblas.so.3", "librocblas.so.5", "libamdhip64.so.7"] as const

// Windows win-rocm archives bundle amdhip64_7.dll but still require the HIP SDK
// blas stack (hipblas/rocblas and Tensile data) from a ROCm/TheRock install.
export const ROCM_RUNTIME_LIBS_WIN = ["hipblas.dll", "rocblas.dll"] as const

export const ROCM_RUNTIME_LIBS = ROCM_RUNTIME_LIBS_LINUX

export function hipPlatformSupported(platform = process.platform, arch = process.arch): boolean {
  return HIP_HOSTS.has(`${platform}-${arch}`)
}

export function readGpuInventory(platform = process.platform): GpuInventory {
  if (platform === "linux") return readLinuxGpuInventory()
  if (platform === "win32") return readWindowsGpuInventory()
  return { amd: false, nvidia: false }
}

function readLinuxGpuInventory(): GpuInventory {
  const inventory = { amd: false, nvidia: false }
  const drm = "/sys/class/drm"
  if (!existsSync(drm)) return inventory
  for (const entry of readdirSync(drm)) {
    if (!entry.startsWith("card")) continue
    const vendorPath = path.join(drm, entry, "device", "vendor")
    if (!existsSync(vendorPath)) continue
    const vendor = readFileSync(vendorPath, "utf8").trim().toLowerCase()
    if (vendor === "0x1002") inventory.amd = true
    if (vendor === "0x10de") inventory.nvidia = true
  }
  return inventory
}

function readWindowsGpuInventory(): GpuInventory {
  const inventory = { amd: false, nvidia: false }
  const system32 = "C:\\Windows\\System32"
  if (existsSync(path.join(system32, "nvcuda.dll"))) inventory.nvidia = true
  if (existsSync(path.join(system32, "nvapi64.dll"))) inventory.nvidia = true
  for (const name of ["amdkmdag.sys", "amdxc64.dll", "amdhip64_7.dll", "atidxx64.dll"]) {
    if (existsSync(path.join(system32, name))) {
      inventory.amd = true
      break
    }
  }
  const programFilesAmd = process.env["ProgramFiles"] ? path.join(process.env["ProgramFiles"], "AMD") : undefined
  if (programFilesAmd && existsSync(programFilesAmd)) inventory.amd = true
  if (process.env.ROCM_PATH && existsSync(process.env.ROCM_PATH)) inventory.amd = true
  return inventory
}

export function rocmRuntimeLibraries(platform = process.platform): readonly string[] {
  if (platform === "win32") return ROCM_RUNTIME_LIBS_WIN
  return ROCM_RUNTIME_LIBS_LINUX
}

export function rocmRuntimeSearchPaths(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): string[] {
  const paths = new Set<string>()
  const add = (value: string | undefined) => {
    const trimmed = value?.trim()
    if (trimmed) paths.add(trimmed)
  }

  if (platform === "win32") {
    add(env.ROCM_PATH ? path.join(env.ROCM_PATH, "bin") : undefined)
    add(env.HIP_PATH ? path.join(env.HIP_PATH, "bin") : undefined)
    const home = env.USERPROFILE ?? env.HOME
    if (home) add(path.join(home, "TheRock", "bin"))
    if (env["ProgramFiles"]) add(path.join(env["ProgramFiles"], "AMD", "ROCm", "bin"))
    if (env.PATH) {
      for (const entry of env.PATH.split(path.delimiter)) add(entry)
    }
    return [...paths]
  }

  add(env.ROCM_PATH ? path.join(env.ROCM_PATH, "bin") : undefined)
  add(env.ROCM_PATH ? path.join(env.ROCM_PATH, "lib") : undefined)
  add("/opt/rocm/lib")
  add("/opt/rocm/bin")
  add("/usr/lib/x86_64-linux-gnu")
  add("/usr/local/lib")
  if (env.LD_LIBRARY_PATH) {
    for (const entry of env.LD_LIBRARY_PATH.split(":")) add(entry)
  }
  if (env.PATH) {
    for (const entry of env.PATH.split(path.delimiter)) add(entry)
  }
  return [...paths]
}

export function rocmRuntimePresentAt(paths: ReadonlyArray<string>, platform = process.platform): boolean {
  return rocmRuntimeLibraries(platform).every((library) => paths.some((dir) => existsSync(path.join(dir, library))))
}

export function rocmRuntimePresent(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): boolean {
  return rocmRuntimePresentAt(rocmRuntimeSearchPaths(env, platform), platform)
}

export function vendoredBinaryExists(
  variant: BackendVariant,
  serverPath?: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const resolved = SemifPaths.resolveServerPath({ configPath: serverPath, env, variant })
  return resolved ? existsSync(resolved) : false
}

export function resolveBackend(input: ResolveInput): BackendStatus {
  const env = input.env ?? process.env
  const inventory = input.inventory ?? readGpuInventory()
  const rocmPresent = input.rocmRuntimePresent ?? rocmRuntimePresent(env)

  if (input.requested === "cpu") {
    return activeCpu(input.requested, "manual_cpu", "semif: using CPU backend (configured)", inventory)
  }

  if (input.requested === "cuda" || input.requested === "vulkan") {
    return fallbackCpu(
      input.requested,
      "unsupported_variant",
      `semif: ${input.requested} backend is not vendored yet; falling back to CPU`,
    )
  }

  if (input.requested === "hip") {
    return resolveHip({
      requested: "hip",
      serverPath: input.serverPath,
      env,
      inventory,
      rocmPresent,
      hipDownloadFailed: input.hipDownloadFailed,
    })
  }

  if (!hipPlatformSupported()) {
    return activeCpu(
      input.requested,
      "platform_unsupported",
      "semif: HIP is not supported on this platform; using CPU",
      inventory,
    )
  }

  if (inventory.amd && inventory.nvidia) {
    return fallbackCpu(
      input.requested,
      "mixed_gpus",
      "semif: mixed AMD and NVIDIA GPUs detected; set semif.backend explicitly instead of auto",
      inventory,
    )
  }

  if (!inventory.amd) {
    return fallbackCpu(input.requested, "no_amd_gpu", "semif: no AMD GPU detected; using CPU backend", inventory)
  }

  return resolveHip({
    requested: "auto",
    serverPath: input.serverPath,
    env,
    inventory,
    rocmPresent,
    hipDownloadFailed: input.hipDownloadFailed,
  })
}

function resolveHip(input: {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env: Record<string, string | undefined>
  readonly inventory: GpuInventory
  readonly rocmPresent: boolean
  readonly hipDownloadFailed?: boolean
}): BackendStatus {
  if (!hipPlatformSupported()) {
    return fallbackCpu(
      input.requested,
      "platform_unsupported",
      "semif: HIP/ROCm is only supported on Windows x64 and Ubuntu x64; using CPU",
      input.inventory,
    )
  }

  if (!input.inventory.amd) {
    return fallbackCpu(input.requested, "no_amd_gpu", "semif: no AMD GPU detected; using CPU backend", input.inventory)
  }

  if (input.hipDownloadFailed) {
    return fallbackCpu(
      input.requested,
      "hip_download_failed",
      "semif: HIP runtime download failed; using CPU backend",
      input.inventory,
    )
  }

  if (!vendoredBinaryExists("hip", input.serverPath, input.env)) {
    return fallbackCpu(
      input.requested,
      "no_vendored_binary",
      "semif: vendored HIP llama-server binary is not available in this build; using CPU backend",
      input.inventory,
    )
  }

  if (!input.rocmPresent) {
    return fallbackCpu(
      input.requested,
      "missing_rocm_runtime",
      "semif: system ROCm/HIP runtime (hipblas/rocblas) is not installed; using CPU backend",
      input.inventory,
      true,
    )
  }

  return {
    requested: input.requested,
    active: "hip",
    fallback: false,
    systemRuntimeMissing: false,
    amdGpu: input.inventory.amd,
    nvidiaGpu: input.inventory.nvidia,
    message: "semif: HIP/ROCm backend active",
  }
}

function activeCpu(
  requested: BackendPreference,
  reason: BackendFallbackReason,
  message: string,
  inventory: GpuInventory,
): BackendStatus {
  return {
    requested,
    active: "cpu",
    fallback: reason !== "manual_cpu",
    fallbackReason: reason === "manual_cpu" ? undefined : reason,
    message,
    systemRuntimeMissing: false,
    amdGpu: inventory.amd,
    nvidiaGpu: inventory.nvidia,
  }
}

function fallbackCpu(
  requested: BackendPreference,
  reason: BackendFallbackReason,
  message: string,
  inventory: GpuInventory = readGpuInventory(),
  systemRuntimeMissing = false,
): BackendStatus {
  return {
    requested,
    active: "cpu",
    fallback: true,
    fallbackReason: reason,
    message,
    systemRuntimeMissing,
    amdGpu: inventory.amd,
    nvidiaGpu: inventory.nvidia,
  }
}

export const hostTriple = hostTarget

export function inspect(input: ResolveInput): BackendStatus {
  const status = resolveBackend(input)
  if (status.active !== "hip") return status
  if (vendoredBinaryExists("hip", input.serverPath, input.env)) return status
  return fallbackCpu(
    input.requested,
    "no_vendored_binary",
    "semif: vendored HIP llama-server binary is not available; using CPU backend",
    input.inventory ?? readGpuInventory(),
  )
}

export * as SemifBackend from "./backend"
