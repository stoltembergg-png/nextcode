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
