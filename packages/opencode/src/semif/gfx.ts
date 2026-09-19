// AMD GPU gfx target resolution for ROCm device wheels.
//
// Windows lacks Linux-style sysfs; tests and dev hosts can pin gfx with
// NEXTCODE_SEMIF_GFX. Production detection maps common RX product names to
// TheRock gfx targets from the pinned lock matrix.

import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { deviceWheel, embeddedRocmLock, supportedGfx } from "../../script/fetch-rocm-runtime"

export const GFX_ENV = "NEXTCODE_SEMIF_GFX"

const NAME_TO_GFX: ReadonlyArray<[RegExp, string]> = [
  [/\brx\s*7[89]00\b/i, "gfx1100"],
  [/\brx\s*7900\b/i, "gfx1100"],
  [/\brx\s*7800\b/i, "gfx1100"],
  [/\brx\s*7700\b/i, "gfx1100"],
  [/\brx\s*7600\b/i, "gfx1100"],
]

export function isSupportedGfx(gfx: string, lock = embeddedRocmLock()): boolean {
  return deviceWheel(lock, gfx) !== undefined
}

export function readAmdGfx(env: Record<string, string | undefined> = process.env, platform = process.platform): string | undefined {
  const override = env[GFX_ENV]?.trim()
  if (override) return override
  if (platform === "linux") return readLinuxGfx()
  if (platform === "win32") return readWindowsGfx()
  return undefined
}

export function resolveSupportedGfx(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
  lock = embeddedRocmLock(),
): string | undefined {
  const gfx = readAmdGfx(env, platform)
  if (!gfx) return undefined
  return isSupportedGfx(gfx, lock) ? gfx : undefined
}

export function unsupportedGfx(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
  lock = embeddedRocmLock(),
): string | undefined {
  const gfx = readAmdGfx(env, platform)
  if (!gfx) return undefined
  return isSupportedGfx(gfx, lock) ? undefined : gfx
}

function readLinuxGfx(): string | undefined {
  const drm = "/sys/class/drm"
  if (!existsSync(drm)) return undefined
  for (const entry of readdirSync(drm)) {
    if (!entry.startsWith("card") || entry.includes("-")) continue
    const deviceDir = path.join(drm, entry, "device")
    const vendorPath = path.join(deviceDir, "vendor")
    if (!existsSync(vendorPath) || readFileSync(vendorPath, "utf8").trim().toLowerCase() !== "0x1002") continue
    const namePath = path.join(deviceDir, "product_name")
    if (existsSync(namePath)) {
      const mapped = mapNameToGfx(readFileSync(namePath, "utf8"))
      if (mapped) return mapped
    }
  }
  return undefined
}

function readWindowsGfx(): string | undefined {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -match \'VEN_1002\' } | Select-Object -ExpandProperty Name"',
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
    for (const line of output.split(/\r?\n/)) {
      const mapped = mapNameToGfx(line)
      if (mapped) return mapped
    }
  } catch {
    return undefined
  }
  return undefined
}

function mapNameToGfx(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  for (const [pattern, gfx] of NAME_TO_GFX) {
    if (pattern.test(trimmed)) return gfx
  }
  return undefined
}

export function listSupportedGfx(lock = embeddedRocmLock()): readonly string[] {
  return supportedGfx(lock)
}

export * as SemifGfx from "./gfx"
