import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"
import { hipPlatformSupported, inspect, resolveBackend } from "../../src/semif/backend"
import { SERVER_ENV } from "../../src/semif/paths"

const amdInventory = { amd: true, nvidia: false }

type ServiceState = {
  readonly status: string
  readonly handle?: object
  readonly hipDownloadFailed?: boolean
  readonly hipFetching?: boolean
  readonly vulkanDownloadFailed?: boolean
  readonly vulkanFetching?: boolean
}

// Mirrors the ready transition in `SemifService.acquireHandle`.
const markReady = (state: ServiceState, handle: object): ServiceState => ({
  ...state,
  status: "ready",
  handle,
})

describe("semif service HIP fallback state", () => {
  test("ready transition preserves hip_download_failed for settled backend status", () => {
    if (!hipPlatformSupported()) return
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const serverPath = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    const afterFailedFetch: ServiceState = {
      status: "offline",
      hipDownloadFailed: true,
      hipFetching: false,
    }

    const settled = inspect({
      requested: "auto",
      serverPath,
      env: { [SERVER_ENV]: serverPath },
      inventory: amdInventory,
      hipDownloadFailed: markReady(afterFailedFetch, {}).hipDownloadFailed,
      hipFetching: markReady(afterFailedFetch, {}).hipFetching,
    })

    expect(settled.fallbackReason).toBe("hip_download_failed")
    expect(settled.fallbackReason).not.toBe("no_vendored_binary")
  })

  test("wiping hipDownloadFailed on ready would misreport no_vendored_binary", () => {
    if (!hipPlatformSupported()) return
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const serverPath = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    const afterFailedFetch: ServiceState = {
      status: "offline",
      hipDownloadFailed: true,
      hipFetching: false,
    }

    const wiped: ServiceState = { status: "ready", handle: {} }
    const misreported = inspect({
      requested: "auto",
      serverPath,
      env: { [SERVER_ENV]: serverPath },
      inventory: amdInventory,
      hipDownloadFailed: wiped.hipDownloadFailed,
      hipFetching: wiped.hipFetching,
    })

    expect(misreported.fallbackReason).toBe("no_vendored_binary")
  })

  test("mid-fetch status does not report no_vendored_binary while HIP fetch is in flight", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-service-state-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const serverPath = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(serverPath, "cpu")
    try {
      const fetching = resolveBackend({
        requested: "auto",
        serverPath,
        env: { [SERVER_ENV]: serverPath },
        inventory: amdInventory,
        rocmRuntimePresent: true,
        hipFetching: true,
      })
      expect(fetching.fallbackReason).toBeUndefined()
      expect(fetching.fallback).toBe(false)
      expect(fetching.message).toContain("fetching HIP runtime")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("semif service Vulkan fallback state", () => {
  test("ready transition preserves vulkan_download_failed for settled backend status", () => {
    if (!hipPlatformSupported()) return
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const serverPath = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    const afterFailedFetch: ServiceState = {
      status: "offline",
      vulkanDownloadFailed: true,
      vulkanFetching: false,
    }

    const settled = inspect({
      requested: "auto",
      serverPath,
      env: { [SERVER_ENV]: serverPath },
      inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
      vulkanDownloadFailed: markReady(afterFailedFetch, {}).vulkanDownloadFailed,
      vulkanFetching: markReady(afterFailedFetch, {}).vulkanFetching,
      vulkanLoaderPresent: true,
    })

    expect(settled.fallbackReason).toBe("vulkan_download_failed")
    expect(settled.fallbackReason).not.toBe("no_vendored_binary")
    expect(settled.fallbackReason).not.toBe("hip_download_failed")
  })

  test("mid-fetch status does not report no_vendored_binary while Vulkan fetch is in flight", () => {
    if (!hipPlatformSupported()) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-service-vulkan-state-"))
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const serverPath = path.join(root, stagedServerName(triple, "cpu", isZip))
    writeFileSync(serverPath, "cpu")
    try {
      const fetching = resolveBackend({
        requested: "auto",
        serverPath,
        env: { [SERVER_ENV]: serverPath },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
        vulkanFetching: true,
        vulkanLoaderPresent: true,
      })
      expect(fetching.fallbackReason).toBeUndefined()
      expect(fetching.fallback).toBe(false)
      expect(fetching.message).toContain("fetching Vulkan runtime")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("service.ts fetches Vulkan before HIP and records vulkanDownloadFailed on auto failure", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/semif/service.ts")).text()
    const body = (name: string) => {
      const start = source.indexOf(`const ${name}`)
      expect(start).toBeGreaterThan(-1)
      const from = start + 1
      const next = source.slice(from).search(/\n    const ensure/)
      return source.slice(start, next === -1 ? undefined : from + next)
    }

    const vulkanBody = body("ensureVulkanRuntime")
    expect(vulkanBody).toContain("vulkanFetching: true")
    expect(vulkanBody).toContain("vulkanDownloadFailed: true")
    expect(vulkanBody).not.toContain("hipDownloadFailed: true")
    expect(vulkanBody).toContain("SemifVulkanRuntime.ensure")
    expect(vulkanBody).toContain("SemifVulkanRuntime.shouldFetch")

    const acquireStart = source.indexOf("const acquireHandle")
    const acquireSlice = source.slice(acquireStart, source.indexOf("const ensureHandle", acquireStart))
    expect(acquireSlice.indexOf("yield* ensureVulkanRuntime")).toBeGreaterThan(-1)
    expect(acquireSlice.indexOf("yield* ensureVulkanRuntime")).toBeLessThan(acquireSlice.indexOf("yield* ensureHipRuntime"))
    expect(acquireSlice.lastIndexOf("yield* dropHandleIfStale")).toBeGreaterThan(
      acquireSlice.indexOf("yield* ensureVulkanRuntime"),
    )
    expect(source).toContain("current.handle.nGpuLayers !== expectedNgl")

    expect(source).toContain("vulkanFetching: current.vulkanFetching")
    expect(source).toContain("vulkanDownloadFailed: current.vulkanDownloadFailed")
    expect(source).toContain("variant: activeVariant")

    expect(body("ensureHipRuntime")).toContain("amdHipUnsupported(inventory)")
    expect(body("ensureRocmRuntime")).toContain("amdHipUnsupported(inventory)")
  })

  test("dropHandle only clears state when the captured handle is still current", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/semif/service.ts")).text()
    const start = source.indexOf("const dropHandle =")
    const end = source.indexOf("const dropHandleIfDead")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body).toContain("Ref.modify")
    expect(body).toContain("if (value.handle !== handle) return [false, value]")
    expect(body).toContain("if (!dropped) return")
    expect(body.indexOf("SemifSidecar.dispose")).toBeGreaterThan(body.indexOf("if (!dropped) return"))
    expect(body.indexOf("SemifScoring.clearCaches()")).toBeGreaterThan(body.indexOf("if (!dropped) return"))
  })
})
