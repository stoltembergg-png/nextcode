import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { $ } from "bun"
import {
  embeddedRocmLock,
  readRocmLock,
  rocmRuntimeComplete,
  runtimeStageKey,
  stageWheelsToDir,
  supportedGfx,
} from "../../script/fetch-rocm-runtime"

async function writeWheel(archive: string, entries: Record<string, string>) {
  const work = mkdtempSync(path.join(tmpdir(), "rocm-wheel-"))
  for (const [name, contents] of Object.entries(entries)) {
    const file = path.join(work, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  const result = await $`zip -qr ${archive} .`.cwd(work).quiet().nothrow()
  rmSync(work, { recursive: true, force: true })
  if (result.exitCode !== 0) throw new Error(`zip failed (${result.exitCode})`)
}

describe("fetch-rocm-runtime lock", () => {
  test("embedded lock pins ROCm 10.0 Windows wheels with verified gfx1100 device package", async () => {
    const lock = await readRocmLock()
    expect(lock.version).toBe("10.0.0")
    expect(lock.platform).toBe("win32-x64")
    expect(lock.packages.core.sha256).toBe("066195cb0f7df02e6009facb17652dd992d13fae44d87652e5ab928d5b4f0851")
    expect(lock.packages.libraries.sha256).toBe("bfc7a1bd3b6050fb4d36d8ac2eea80d3afd70c5604a29142463d6cb890fc73bf")
    expect(lock.devices.gfx1100.sha256).toBe("db39cbc5aae7a67c73d76692899a6a89bbc10eafc92f856f48e9c03247a91f8e")
    expect(supportedGfx(lock)).toEqual(["gfx1030", "gfx1100", "gfx1150", "gfx1200"])
    expect(lock.devices.gfx1030.sha256).toBe("19ada0359b499c19c1ecb1cba21b067fce89b4f0b0de6f0f7b76cbef85dcb85b")
    expect(lock.devices.gfx1150.bytes).toBe(134574199)
    expect(lock.devices.gfx1200.bytes).toBe(377648520)
    expect(runtimeStageKey(lock, "gfx1100")).toMatch(/^rocm-10\.0\.0-gfx1100-[0-9a-f]{12}$/)
  })
})

describe("fetch-rocm-runtime staging", () => {
  test("stageWheelsToDir extracts bin and rocblas/library from wheels", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rocm-stage-"))
    const core = path.join(root, "core.whl")
    const libraries = path.join(root, "libraries.whl")
    const device = path.join(root, "device.whl")
    await writeWheel(core, {
      "_rocm_sdk_core/bin/amdhip64_7.dll": "core",
    })
    await writeWheel(libraries, {
      "_rocm_sdk_libraries/bin/hipblas.dll": "hipblas",
      "_rocm_sdk_libraries/bin/rocblas.dll": "rocblas",
      "_rocm_sdk_libraries/bin/rocblas/library/kernel.dat": "kernel",
    })
    await writeWheel(device, {
      "_rocm_sdk_libraries/bin/hipblaslt/library/gfx1100/kernel.dat": "hipblaslt",
    })
    const dest = path.join(root, "staged")
    const layout = await stageWheelsToDir([{ archive: core }, { archive: libraries }, { archive: device }], dest)
    expect(layout.binDir).toBe(path.join(dest, "bin"))
    expect(rocmRuntimeComplete(dest)).toBe(true)
    expect(Bun.file(path.join(dest, "bin", "amdhip64_7.dll")).size).toBeGreaterThan(0)
    expect(layout.rocblasLibraryDir).toBe(path.join(dest, "rocblas", "library"))
    expect(layout.hipblasltLibraryDir).toBe(path.join(dest, "hipblaslt", "library"))
    rmSync(root, { recursive: true, force: true })
  })
})
