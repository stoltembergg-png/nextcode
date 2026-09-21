// Backend variant selection for the vendored llama-server runtime.
//
// Variants are exclusive (`cpu | cuda | hip | vulkan`). `auto` picks one on
// supported platforms; mixed AMD+NVIDIA hosts require an explicit backend. CPU
// fallback is always visible in status and logs — never silent.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { embeddedRocmLock, rocmRuntimeComplete, runtimeStageKey } from "../../script/fetch-rocm-runtime"
import { hostTarget } from "../../script/fetch-semif-server"
import { GFX_ENV, isSupportedGfx, resolveSupportedGfx, unsupportedGfx } from "./gfx"
import { rocmVendorSupported } from "./rocm-runtime"
import { SemifPaths } from "./paths"

export type BackendVariant = "cpu" | "cuda" | "hip" | "vulkan"
export type BackendPreference = "auto" | BackendVariant

export type BackendFallbackReason =
  | "manual_cpu"
  | "platform_unsupported"
  | "mixed_gpus"
  | "no_amd_gpu"
  | "gpu_unsupported"
  | "missing_rocm_runtime"
  | "no_vendored_binary"
  | "hip_download_failed"
  | "vulkan_download_failed"
  | "missing_vulkan_runtime"
  | "unsupported_variant"

export interface GpuInventory {
  readonly amd: boolean
  readonly nvidia: boolean
  // AMD gfx arch (e.g. gfx803, gfx1030) when probed from PCI device id; omitted when unknown.
  readonly amdGfx?: string
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
  readonly hipFetching?: boolean
  readonly rocmFetching?: boolean
  readonly vulkanDownloadFailed?: boolean
  readonly vulkanFetching?: boolean
  readonly vulkanLoaderPresent?: boolean
}

const HIP_HOSTS = new Set(["win32-x64", "linux-x64"])

// TheRock Windows HIP redistributable families (RDNA1+). Polaris/Vega and other
// pre-gfx101X arches are outside this matrix (e.g. RX 580 = gfx803).
const THEROCK_WIN_HIP_GFX_PREFIXES = ["gfx101", "gfx103", "gfx110", "gfx115", "gfx120"] as const

// Common AMD PCI device ids → gfx arch. Unknown ids stay unmapped so we never
// falsely mark a host unsupported.
const AMD_PCI_GFX: Record<string, string> = {
  "0x67c0": "gfx803",
  "0x67c1": "gfx803",
  "0x67c2": "gfx803",
  "0x67c4": "gfx803",
  "0x67c7": "gfx803",
  "0x67cf": "gfx803",
  "0x67d0": "gfx803",
  "0x67df": "gfx803",
  "0x67e0": "gfx803",
  "0x67e3": "gfx803",
  "0x67e8": "gfx803",
  "0x67e9": "gfx803",
  "0x67ef": "gfx803",
  "0x67ff": "gfx803",
  "0x6fd8": "gfx803",
  "0x6fd9": "gfx803",
  "0x6fdc": "gfx803",
  "0x6fdd": "gfx803",
  "0x6fde": "gfx803",
  "0x6fdf": "gfx803",
  "0x6860": "gfx900",
  "0x6861": "gfx901",
  "0x6862": "gfx902",
  "0x6863": "gfx902",
  "0x6864": "gfx902",
  "0x6867": "gfx900",
  "0x6868": "gfx900",
  "0x6869": "gfx900",
  "0x687f": "gfx900",
  "0x66a0": "gfx906",
  "0x66a1": "gfx906",
  "0x66a2": "gfx906",
  "0x66a3": "gfx906",
  "0x7310": "gfx1010",
  "0x7312": "gfx1012",
  "0x7318": "gfx1013",
  "0x7319": "gfx1012",
  "0x731a": "gfx1013",
  "0x731b": "gfx1013",
  "0x731e": "gfx1011",
  "0x731f": "gfx1010",
  "0x73a0": "gfx1030",
  "0x73a1": "gfx1030",
  "0x73a2": "gfx1030",
  "0x73a3": "gfx1030",
  "0x73ab": "gfx1031",
  "0x73ae": "gfx1030",
  "0x73af": "gfx1030",
  "0x73bf": "gfx1030",
  "0x73df": "gfx1031",
  "0x73e0": "gfx1032",
  "0x73e1": "gfx1032",
  "0x73e2": "gfx1032",
  "0x73e3": "gfx1032",
  "0x744c": "gfx1100",
  "0x7470": "gfx1101",
  "0x7478": "gfx1102",
  "0x747e": "gfx1101",
  "0x7480": "gfx1100",
  "0x7481": "gfx1100",
  "0x7483": "gfx1100",
  "0x7489": "gfx1103",
  "0x150e": "gfx1150",
  "0x1586": "gfx1151",
  "0x1587": "gfx1151",
  "0x7440": "gfx1200",
  "0x7441": "gfx1200",
  "0x7442": "gfx1201",
}

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

export function gfxFromAmdDeviceId(deviceId: string): string | undefined {
  const normalized = deviceId.trim().toLowerCase()
  const prefixed = normalized.startsWith("0x") ? normalized : `0x${normalized}`
  return AMD_PCI_GFX[prefixed]
}

export function therockWinHipGfxSupported(gfx: string): boolean {
  const normalized = gfx.trim().toLowerCase()
  return THEROCK_WIN_HIP_GFX_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export function amdGpuUnsupportedForWinHip(
  inventory: GpuInventory,
  platform = process.platform,
  arch = process.arch,
): boolean {
  if (`${platform}-${arch}` !== "win32-x64") return false
  if (!inventory.amdGfx) return false
  return !therockWinHipGfxSupported(inventory.amdGfx)
}

export function amdHipUnsupported(
  inventory: GpuInventory,
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
  arch = process.arch,
): boolean {
  // Env gfx wins over inventory so NEXTCODE_SEMIF_GFX can force HIP on a
  // Polaris PCI id, or Vulkan on a supported inventory family.
  if (env[GFX_ENV]?.trim()) return Boolean(unsupportedGfx(env, platform))
  if (amdGpuUnsupportedForWinHip(inventory, platform, arch)) return true
  // Linux ROCm wheels are narrower than Windows TheRock. Do not feed Windows
  // inventory gfx (e.g. gfx1010) through isSupportedGfx.
  if (platform !== "win32" && inventory.amdGfx && !isSupportedGfx(inventory.amdGfx)) return true
  return Boolean(unsupportedGfx(env, platform))
}

export function readGpuInventory(platform = process.platform): GpuInventory {
  if (platform === "linux") return readLinuxGpuInventory()
  if (platform === "win32") return readWindowsGpuInventory()
  return { amd: false, nvidia: false }
}

function readLinuxGpuInventory(): GpuInventory {
  const inventory = { amd: false, nvidia: false, amdGfx: undefined as string | undefined }
  const drm = "/sys/class/drm"
  if (!existsSync(drm)) return inventory
  for (const entry of readdirSync(drm)) {
    if (!/^card\d+$/.test(entry)) continue
    const deviceDir = path.join(drm, entry, "device")
    const vendorPath = path.join(deviceDir, "vendor")
    if (!existsSync(vendorPath)) continue
    const vendor = readFileSync(vendorPath, "utf8").trim().toLowerCase()
    if (vendor === "0x1002") {
      inventory.amd = true
      const devicePath = path.join(deviceDir, "device")
      if (existsSync(devicePath) && !inventory.amdGfx) {
        inventory.amdGfx = gfxFromAmdDeviceId(readFileSync(devicePath, "utf8").trim())
      }
    }
    if (vendor === "0x10de") inventory.nvidia = true
  }
  return inventory
}

let cachedWindowsAmdDeviceIds: string[] | undefined

function readWindowsAmdDeviceIds(): string[] {
  if (cachedWindowsAmdDeviceIds) return cachedWindowsAmdDeviceIds
  const result = Bun.spawnSync({
    cmd: [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -match 'VEN_1002' } | ForEach-Object { $_.PNPDeviceID }",
    ],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  })
  if (!result.success) return []
  const ids = result.stdout
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/DEV_([0-9A-Fa-f]{4})/)
      return match ? `0x${match[1].toLowerCase()}` : undefined
    })
    .filter((id): id is string => Boolean(id))
  cachedWindowsAmdDeviceIds = ids
  return ids
}

function readWindowsGpuInventory(): GpuInventory {
  const inventory = { amd: false, nvidia: false, amdGfx: undefined as string | undefined }
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
  for (const deviceId of readWindowsAmdDeviceIds()) {
    inventory.amd = true
    if (!inventory.amdGfx) inventory.amdGfx = gfxFromAmdDeviceId(deviceId)
  }
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
  if (rocmVendorSupported(platform) && stagedRocmRuntimePresent(env)) return true
  return rocmRuntimePresentAt(rocmRuntimeSearchPaths(env, platform), platform)
}

export function stagedRocmRuntimePresent(env: Record<string, string | undefined> = process.env): boolean {
  const gfx = resolveSupportedGfx(env)
  if (!gfx) return false
  const dir = SemifPaths.rocmRuntimeDir(runtimeStageKey(embeddedRocmLock(), gfx))
  return rocmRuntimeComplete(dir)
}

export function vulkanLoaderSearchPaths(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): string[] {
  const paths = new Set<string>()
  const add = (value: string | undefined) => {
    const trimmed = value?.trim()
    if (trimmed) paths.add(trimmed)
  }
  if (platform === "win32") {
    add(env.SystemRoot ? path.join(env.SystemRoot, "System32") : undefined)
    add(env.SYSTEMROOT ? path.join(env.SYSTEMROOT, "System32") : undefined)
    if (env.PATH) {
      for (const entry of env.PATH.split(path.delimiter)) add(entry)
    }
    return [...paths]
  }
  add("/usr/lib/x86_64-linux-gnu")
  add("/lib/x86_64-linux-gnu")
  add("/usr/lib")
  add("/usr/local/lib")
  if (env.LD_LIBRARY_PATH) {
    for (const entry of env.LD_LIBRARY_PATH.split(":")) add(entry)
  }
  return [...paths]
}

export function vulkanLoaderPresent(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): boolean {
  const names = platform === "win32" ? ["vulkan-1.dll"] : ["libvulkan.so.1"]
  return vulkanLoaderSearchPaths(env, platform).some((dir) => names.some((name) => existsSync(path.join(dir, name))))
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
  const loaderPresent = input.vulkanLoaderPresent ?? vulkanLoaderPresent(env)

  if (input.requested === "cpu") {
    return activeCpu(input.requested, "manual_cpu", "semif: using CPU backend (configured)", inventory)
  }

  if (input.requested === "cuda") {
    return fallbackCpu(
      input.requested,
      "unsupported_variant",
      `semif: ${input.requested} backend is not vendored yet; falling back to CPU`,
    )
  }

  if (input.requested === "vulkan") {
    return resolveVulkan({
      requested: "vulkan",
      serverPath: input.serverPath,
      env,
      inventory,
      vulkanDownloadFailed: input.vulkanDownloadFailed,
      vulkanFetching: input.vulkanFetching,
      vulkanLoaderPresent: loaderPresent,
    })
  }

  if (input.requested === "hip") {
    return resolveHip({
      requested: "hip",
      serverPath: input.serverPath,
      env,
      inventory,
      rocmPresent,
      hipDownloadFailed: input.hipDownloadFailed,
      hipFetching: input.hipFetching,
      rocmFetching: input.rocmFetching,
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

  if (amdHipUnsupported(inventory, env)) {
    return resolveVulkan({
      requested: "auto",
      serverPath: input.serverPath,
      env,
      inventory,
      vulkanDownloadFailed: input.vulkanDownloadFailed,
      vulkanFetching: input.vulkanFetching,
      vulkanLoaderPresent: loaderPresent,
    })
  }

  return resolveHip({
    requested: "auto",
    serverPath: input.serverPath,
    env,
    inventory,
    rocmPresent,
    hipDownloadFailed: input.hipDownloadFailed,
    hipFetching: input.hipFetching,
    rocmFetching: input.rocmFetching,
  })
}

function resolveHip(input: {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env: Record<string, string | undefined>
  readonly inventory: GpuInventory
  readonly rocmPresent: boolean
  readonly hipDownloadFailed?: boolean
  readonly hipFetching?: boolean
  readonly rocmFetching?: boolean
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

  if (!input.env[GFX_ENV]?.trim() && amdGpuUnsupportedForWinHip(input.inventory)) {
    return fallbackCpu(
      input.requested,
      "gpu_unsupported",
      `semif: AMD GPU ${input.inventory.amdGfx} is outside the supported Windows HIP matrix (e.g. Polaris/RX 580); using CPU backend`,
      input.inventory,
    )
  }

  const blockedGfx = input.env[GFX_ENV]?.trim()
    ? unsupportedGfx(input.env)
    : (unsupportedGfx(input.env) ??
      (process.platform !== "win32" && input.inventory.amdGfx && !isSupportedGfx(input.inventory.amdGfx)
        ? input.inventory.amdGfx
        : undefined))
  if (blockedGfx) {
    return fallbackCpu(
      input.requested,
      "gpu_unsupported",
      `semif: AMD GPU gfx ${blockedGfx} is not supported by the vendored HIP/ROCm runtime; using CPU backend`,
      input.inventory,
    )
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
    if (input.hipFetching) {
      return {
        requested: input.requested,
        active: "cpu",
        fallback: false,
        systemRuntimeMissing: false,
        amdGpu: input.inventory.amd,
        nvidiaGpu: input.inventory.nvidia,
        message: "semif: fetching HIP runtime",
      }
    }
    return fallbackCpu(
      input.requested,
      "no_vendored_binary",
      "semif: vendored HIP llama-server binary is not available in this build; using CPU backend",
      input.inventory,
    )
  }

  if (!input.rocmPresent) {
    if (input.rocmFetching || input.hipFetching) {
      return {
        requested: input.requested,
        active: "cpu",
        fallback: false,
        systemRuntimeMissing: false,
        amdGpu: input.inventory.amd,
        nvidiaGpu: input.inventory.nvidia,
        message: input.rocmFetching ? "semif: fetching ROCm runtime" : "semif: fetching HIP runtime",
      }
    }
    if (rocmVendorSupported() && resolveSupportedGfx(input.env)) {
      return {
        requested: input.requested,
        active: "cpu",
        fallback: false,
        systemRuntimeMissing: true,
        amdGpu: input.inventory.amd,
        nvidiaGpu: input.inventory.nvidia,
        message: "semif: ROCm runtime is not staged yet",
      }
    }
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

function resolveVulkan(input: {
  readonly requested: BackendPreference
  readonly serverPath?: string
  readonly env: Record<string, string | undefined>
  readonly inventory: GpuInventory
  readonly vulkanDownloadFailed?: boolean
  readonly vulkanFetching?: boolean
  readonly vulkanLoaderPresent: boolean
}): BackendStatus {
  if (!hipPlatformSupported()) {
    return fallbackCpu(
      input.requested,
      "platform_unsupported",
      "semif: Vulkan is only supported on Windows x64 and Ubuntu x64; using CPU",
      input.inventory,
    )
  }

  if (!input.inventory.amd) {
    return fallbackCpu(input.requested, "no_amd_gpu", "semif: no AMD GPU detected; using CPU backend", input.inventory)
  }

  if (!input.vulkanLoaderPresent) {
    return fallbackCpu(
      input.requested,
      "missing_vulkan_runtime",
      "semif: Vulkan driver loader is not available; using CPU backend",
      input.inventory,
      true,
    )
  }

  if (input.vulkanDownloadFailed) {
    return fallbackCpu(
      input.requested,
      "vulkan_download_failed",
      "semif: Vulkan runtime download failed; using CPU backend",
      input.inventory,
    )
  }

  if (!vendoredBinaryExists("vulkan", input.serverPath, input.env)) {
    if (input.vulkanFetching) {
      return {
        requested: input.requested,
        active: "cpu",
        fallback: false,
        systemRuntimeMissing: false,
        amdGpu: input.inventory.amd,
        nvidiaGpu: input.inventory.nvidia,
        message: "semif: fetching Vulkan runtime",
      }
    }
    return fallbackCpu(
      input.requested,
      "no_vendored_binary",
      "semif: vendored Vulkan llama-server binary is not available in this build; using CPU backend",
      input.inventory,
    )
  }

  return {
    requested: input.requested,
    active: "vulkan",
    fallback: false,
    systemRuntimeMissing: false,
    amdGpu: input.inventory.amd,
    nvidiaGpu: input.inventory.nvidia,
    message: "semif: Vulkan backend active",
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
  if (status.active === "hip") {
    if (vendoredBinaryExists("hip", input.serverPath, input.env)) return status
    return fallbackCpu(
      input.requested,
      "no_vendored_binary",
      "semif: vendored HIP llama-server binary is not available; using CPU backend",
      input.inventory ?? readGpuInventory(),
    )
  }
  if (status.active !== "vulkan") return status
  if (vendoredBinaryExists("vulkan", input.serverPath, input.env)) return status
  return fallbackCpu(
    input.requested,
    "no_vendored_binary",
    "semif: vendored Vulkan llama-server binary is not available; using CPU backend",
    input.inventory ?? readGpuInventory(),
  )
}

export * as SemifBackend from "./backend"
