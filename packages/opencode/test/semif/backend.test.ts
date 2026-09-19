import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import {
  hipPlatformSupported,
  resolveBackend,
  rocmRuntimePresentAt,
  rocmRuntimeSearchPaths,
} from "../../src/semif/backend"
import { SERVER_ENV } from "../../src/semif/paths"

describe("semif backend", () => {
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
    const status = resolveBackend({
      requested: "hip",
      inventory: { amd: true, nvidia: false },
      rocmRuntimePresent: false,
    })
    if (!hipPlatformSupported()) return
    expect(status.active).toBe("cpu")
    expect(status.fallbackReason).toBe("missing_rocm_runtime")
    expect(status.systemRuntimeMissing).toBe(true)
  })

  test("hip activates when amd, rocm, and vendored binary are present", () => {
    const root = mkdtempSync(path.join(tmpdir(), "semif-backend-"))
    const cpu = path.join(root, "llama-server-x86_64-pc-windows-msvc.exe")
    const hip = path.join(root, "llama-server-x86_64-pc-windows-msvc-hip.exe")
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
      if (!hipPlatformSupported("win32", "x64")) return
      expect(status.active).toBe("hip")
      expect(status.fallback).toBe(false)
      expect(status.systemRuntimeMissing).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rocm runtime detection requires all blas libraries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "semif-rocm-"))
    const libdir = path.join(root, "lib")
    mkdirSync(libdir)
    writeFileSync(path.join(libdir, "libhipblas.so.3"), "")
    writeFileSync(path.join(libdir, "librocblas.so.5"), "")
    try {
      expect(rocmRuntimePresentAt([libdir])).toBe(false)
      writeFileSync(path.join(libdir, "libamdhip64.so.7"), "")
      expect(rocmRuntimePresentAt([libdir])).toBe(true)
      expect(rocmRuntimeSearchPaths({ ROCM_PATH: root }).some((entry) => entry.includes("lib"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
