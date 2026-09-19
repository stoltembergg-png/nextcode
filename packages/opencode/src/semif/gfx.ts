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
  [/\brx\s*5[78]0\b/i, "gfx803"],
  [/\brx\s*580\b/i, "gfx803"],
  [/\brx\s*570\b/i, "gfx803"],
  [/\brx\s*560\b/i, "gfx803"],
  [/\brx\s*480\b/i, "gfx803"],
  [/\brx\s*470\b/i, "gfx803"],
  [/\brx\s*6[0-9]{3}\b/i, "gfx1030"],
]

// Polaris and other pre-gfx1100 device IDs map to gfx targets outside the pinned wheel matrix.
const PCI_TO_GFX: Record<string, string> = {
  "67c0": "gfx803",
  "67c2": "gfx803",
  "67c4": "gfx803",
  "67df": "gfx803",
  "67e0": "gfx803",
  "67e1": "gfx803",
  "67e3": "gfx803",
  "67e8": "gfx803",
  "67ef": "gfx803",
  "67ff": "gfx803",
  "6980": "gfx803",
  "6981": "gfx803",
  "6985": "gfx803",
  "6986": "gfx803",
  "6987": "gfx803",
  "699f": "gfx803",
  "7310": "gfx1030",
  "731f": "gfx1030",
  "7340": "gfx1030",
  "7341": "gfx1030",
  "73bf": "gfx1030",
  "73df": "gfx1030",
  "73ef": "gfx1030",
  "73ff": "gfx1030",
}

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
    const devicePath = path.join(deviceDir, "device")
    if (existsSync(devicePath)) {
      const mapped = mapPciToGfx(readFileSync(devicePath, "utf8"))
      if (mapped) return mapped
    }
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
      "powershell -NoProfile -Command \"Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -match 'VEN_1002' } | ForEach-Object { $_.PNPDeviceID + '|' + $_.Name }\"",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
    for (const line of output.split(/\r?\n/)) {
      const [pnp = "", name = ""] = line.split("|")
      const mapped = mapPciToGfx(pnp) ?? mapNameToGfx(name)
      if (mapped) return mapped
    }
  } catch {
    return undefined
  }
  return undefined
}

function mapPciToGfx(value: string): string | undefined {
  const match = value.trim().match(/(?:DEV_|0x)([0-9a-f]{4})/i)
  if (!match) return undefined
  return PCI_TO_GFX[match[1].toLowerCase()]
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
