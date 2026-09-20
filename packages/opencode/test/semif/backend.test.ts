import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"
import {
  amdGpuUnsupportedForWinHip,
  amdHipUnsupported,
  gfxFromAmdDeviceId,
  hipPlatformSupported,
  resolveBackend,
  rocmRuntimePresentAt,
  rocmRuntimeSearchPaths,
  therockWinHipGfxSupported,
} from "../../src/semif/backend"
import { GFX_ENV } from "../../src/semif/gfx"
import { SERVER_ENV } from "../../src/semif/paths"

describe("semif backend", () => {
  test("gfxFromAmdDeviceId maps Polaris RX 580 to gfx803", () => {
    expect(gfxFromAmdDeviceId("0x67df")).toBe("gfx803")
    expect(gfxFromAmdDeviceId("67df")).toBe("gfx803")
    expect(gfxFromAmdDeviceId("0xffff")).toBeUndefined()
  })

  test("therockWinHipGfxSupported accepts RDNA families only", () => {
    expect(therockWinHipGfxSupported("gfx1030")).toBe(true)
    expect(therockWinHipGfxSupported("gfx1100")).toBe(true)
    expect(therockWinHipGfxSupported("gfx1151")).toBe(true)
    expect(therockWinHipGfxSupported("gfx1200")).toBe(true)
    expect(therockWinHipGfxSupported("gfx803")).toBe(false)
    expect(therockWinHipGfxSupported("gfx900")).toBe(false)
  })

  test("amdGpuUnsupportedForWinHip is win32-only and requires known gfx", () => {
    expect(amdGpuUnsupportedForWinHip({ amd: true, nvidia: false, amdGfx: "gfx803" }, "win32", "x64")).toBe(true)
    expect(amdGpuUnsupportedForWinHip({ amd: true, nvidia: false, amdGfx: "gfx1030" }, "win32", "x64")).toBe(false)
    expect(amdGpuUnsupportedForWinHip({ amd: true, nvidia: false }, "win32", "x64")).toBe(false)
    expect(amdGpuUnsupportedForWinHip({ amd: true, nvidia: false, amdGfx: "gfx803" }, "linux", "x64")).toBe(false)
  })

  test("amdHipUnsupported env-firsts over Windows TheRock inventory", () => {
    const inventory = { amd: true, nvidia: false, amdGfx: "gfx803" }
    expect(amdHipUnsupported(inventory, { [GFX_ENV]: "gfx1030" }, "win32", "x64")).toBe(false)
    expect(amdHipUnsupported(inventory, {}, "win32", "x64")).toBe(true)
  })

  test("known unsupported gfx settles before HIP fetch on win32", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-gpu-unsupported-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(cpu, "cpu")
    try {
      const inventory = { amd: true, nvidia: false, amdGfx: "gfx803" }
      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory,
        rocmRuntimePresent: true,
        hipFetching: true,
      })
      if (process.platform === "win32") {
        expect(status.active).toBe("cpu")
        expect(status.fallbackReason).toBe("gpu_unsupported")
        expect(status.message).toContain("gfx803")
        return
      }
      expect(status.fallbackReason).not.toBe("gpu_unsupported")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("unknown amd gfx keeps existing HIP path", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-gfx-unknown-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(cpu, "cpu")
    try {
      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: true,
        hipFetching: true,
      })
      expect(status.fallbackReason).not.toBe("gpu_unsupported")
      expect(status.message).toContain("fetching HIP runtime")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("supported gfx does not collide with mixed_gpus or no_amd_gpu", () => {
    if (!hipPlatformSupported()) return
    const supported = resolveBackend({
      requested: "auto",
      inventory: { amd: true, nvidia: false, amdGfx: "gfx1030" },
      rocmRuntimePresent: true,
    })
    expect(supported.fallbackReason).not.toBe("gpu_unsupported")
    expect(supported.fallbackReason).not.toBe("mixed_gpus")
    expect(supported.fallbackReason).not.toBe("no_amd_gpu")

    const mixed = resolveBackend({
      requested: "auto",
      inventory: { amd: true, nvidia: true, amdGfx: "gfx803" },
      rocmRuntimePresent: true,
    })
    expect(mixed.fallbackReason).toBe("mixed_gpus")

    const noAmd = resolveBackend({
      requested: "auto",
      inventory: { amd: false, nvidia: false },
      rocmRuntimePresent: true,
    })
    expect(noAmd.fallbackReason).toBe("no_amd_gpu")
  })

  test("manual cpu is active without fallback", () => {
    const status = resolveBackend({
      requested: "cpu",
      inventory: { amd: true, nvidia: false },
      rocmRuntimePresent: true,
    })
    expect(status.active).toBe("cpu")
    expect(status.fallback).toBe(false)
    expect(status.fallbackReason).toBeUndefined()
  })

  test("auto on unsupported platforms stays on cpu", () => {
    const status = resolveBackend({
      requested: "auto",
      inventory: { amd: true, nvidia: false },
      rocmRuntimePresent: true,
    })
    expect(status.active).toBe("cpu")
    if (hipPlatformSupported()) {
      expect(status.fallbackReason).toBe("no_vendored_binary")
    } else {
      expect(status.fallbackReason).toBe("platform_unsupported")
    }
    expect(status.systemRuntimeMissing).toBe(false)
  })

  test("auto on hip-capable hosts without amd falls back visibly", () => {
    const status = resolveBackend({
      requested: "auto",
      inventory: { amd: false, nvidia: false },
      rocmRuntimePresent: true,
    })
    if (!hipPlatformSupported()) return
    expect(status.active).toBe("cpu")
    expect(status.fallbackReason).toBe("no_amd_gpu")
  })

  test("auto with mixed gpus requires explicit backend", () => {
    const status = resolveBackend({
      requested: "auto",
      inventory: { amd: true, nvidia: true },
      rocmRuntimePresent: true,
    })
    if (!hipPlatformSupported()) return
    expect(status.active).toBe("cpu")
    expect(status.fallbackReason).toBe("mixed_gpus")
  })

  test("missing rocm runtime is reported separately from no amd", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-rocm-missing-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const hip = path.join(root, stagedServerName(triple, "hip", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(hip, "hip")
    try {
      const status = resolveBackend({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: false,
      })
      expect(status.active).toBe("cpu")
      expect(status.fallbackReason).toBe("missing_rocm_runtime")
      expect(status.systemRuntimeMissing).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("mid-fetch HIP download does not report no_vendored_binary", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-hip-fetching-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(cpu, "cpu")
    try {
      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: true,
        hipFetching: true,
      })
      expect(status.active).toBe("cpu")
      expect(status.fallback).toBe(false)
      expect(status.fallbackReason).toBeUndefined()
      expect(status.message).toContain("fetching HIP runtime")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hip download failure is reported before missing vendored binary", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-hip-download-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(cpu, "cpu")
    try {
      const status = resolveBackend({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: false,
        hipDownloadFailed: true,
      })
      expect(status.active).toBe("cpu")
      expect(status.fallbackReason).toBe("hip_download_failed")
      expect(status.systemRuntimeMissing).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("cpu-only build reports missing hip binary before missing rocm runtime", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-cpu-only-rocm-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(cpu, "cpu")
    try {
      const status = resolveBackend({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: false,
      })
      expect(status.active).toBe("cpu")
      expect(status.fallbackReason).toBe("no_vendored_binary")
      expect(status.systemRuntimeMissing).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hip does not treat the cpu launcher as a vendored hip binary", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-cpu-only-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(cpu, "cpu")
    try {
      const status = resolveBackend({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: true,
      })
      expect(status.active).toBe("cpu")
      expect(status.fallbackReason).toBe("no_vendored_binary")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hip activates when amd, rocm, and vendored binary are present", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const hip = path.join(root, stagedServerName(triple, "hip", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(hip, "hip")
    try {
      const status = resolveBackend({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: true,
      })
      expect(status.active).toBe("hip")
      expect(status.fallback).toBe(false)
      expect(status.systemRuntimeMissing).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("linux rocm runtime detection requires all blas shared objects", () => {
    const root = mkdtempSync(path.join(tmpdir(), "semif-rocm-"))
    const libdir = path.join(root, "lib")
    mkdirSync(libdir)
    writeFileSync(path.join(libdir, "libhipblas.so.3"), "")
    writeFileSync(path.join(libdir, "librocblas.so.5"), "")
    try {
      expect(rocmRuntimePresentAt([libdir], "linux")).toBe(false)
      writeFileSync(path.join(libdir, "libamdhip64.so.7"), "")
      expect(rocmRuntimePresentAt([libdir], "linux")).toBe(true)
      expect(rocmRuntimeSearchPaths({ ROCM_PATH: root }, "linux").some((entry) => entry.includes("lib"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("windows does not treat bundled amdhip64 as sufficient system runtime", () => {
    const root = mkdtempSync(path.join(tmpdir(), "semif-rocm-win-amdhip-"))
    writeFileSync(path.join(root, "amdhip64_7.dll"), "")
    try {
      expect(rocmRuntimePresentAt([root], "win32")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("windows rocm runtime detection requires hipblas and rocblas dlls", () => {
    const root = mkdtempSync(path.join(tmpdir(), "semif-rocm-win-"))
    const bindir = path.join(root, "bin")
    mkdirSync(bindir)
    writeFileSync(path.join(bindir, "hipblas.dll"), "")
    try {
      expect(rocmRuntimePresentAt([bindir], "win32")).toBe(false)
      writeFileSync(path.join(bindir, "rocblas.dll"), "")
      expect(rocmRuntimePresentAt([bindir], "win32")).toBe(true)
      expect(rocmRuntimePresentAt([bindir], "linux")).toBe(false)
      expect(rocmRuntimeSearchPaths({ ROCM_PATH: root }, "win32")).toContain(bindir)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("auto on gfx803 selects vulkan when the vulkan launcher exists", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-vulkan-auto-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(vulkan, "vulkan")
    try {
      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
        rocmRuntimePresent: false,
      })
      expect(status.active).toBe("vulkan")
      expect(status.fallback).toBe(false)
      expect(status.fallbackReason).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("explicit hip on gfx803 stays gpu_unsupported and does not activate vulkan", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-hip-polar-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(vulkan, "vulkan")
    try {
      const status = resolveBackend({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
        rocmRuntimePresent: true,
      })
      expect(status.active).toBe("cpu")
      expect(status.fallbackReason).toBe("gpu_unsupported")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("auto on Windows gfx1010 prefers hip over vulkan", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-hip-therock-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const hip = path.join(root, stagedServerName(triple, "hip", isZip))
    const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(hip, "hip")
    writeFileSync(vulkan, "vulkan")
    try {
      if (process.platform !== "win32") return
      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx1010" },
        rocmRuntimePresent: true,
      })
      expect(status.active).toBe("hip")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NEXTCODE_SEMIF_GFX supported override wins over polaris inventory", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-gfx-env-win-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const hip = path.join(root, stagedServerName(triple, "hip", isZip))
    const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(hip, "hip")
    writeFileSync(vulkan, "vulkan")
    try {
      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu, [GFX_ENV]: "gfx1030" },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
        rocmRuntimePresent: true,
      })
      expect(status.active).toBe("hip")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("auto on gfx1030 still prefers hip over vulkan", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-hip-rdna-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const hip = path.join(root, stagedServerName(triple, "hip", isZip))
    const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(hip, "hip")
    writeFileSync(vulkan, "vulkan")
    try {
      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx1030" },
        rocmRuntimePresent: true,
      })
      expect(status.active).toBe("hip")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("explicit vulkan activates when the vulkan launcher exists", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-vulkan-explicit-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
    const vulkan = path.join(root, stagedServerName(triple, "vulkan", isZip))
    writeFileSync(cpu, "cpu")
    writeFileSync(vulkan, "vulkan")
    try {
      const status = resolveBackend({
        requested: "vulkan",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
      })
      expect(status.active).toBe("vulkan")
      expect(status.fallback).toBe(false)
      expect(status.fallbackReason).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
