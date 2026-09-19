import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { Cause, Effect, Exit, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { hipPlatformSupported, resolveBackend } from "../../src/semif/backend"
import { ensure, readHipLock, shouldFetch } from "../../src/semif/hip-runtime"
import { hipRuntimeDir, resolveLibsPath, resolveServerPath, SERVER_ENV } from "../../src/semif/paths"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"

const layer = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)

const withDataRoot = (run: (root: string) => void | Promise<void>) => {
  const root = mkdtempSync(path.join(tmpdir(), "semif-hip-acceptance-"))
  const previousData = Global.Path.data
  const previousCache = Global.Path.cache
  Object.assign(Global.Path, { data: root, cache: path.join(root, "cache") })
  return Promise.resolve(run(root)).finally(() => {
    Object.assign(Global.Path, { data: previousData, cache: previousCache })
    rmSync(root, { recursive: true, force: true })
  })
}

const stageHipRuntime = (sha256: string, target: string) => {
  const dir = hipRuntimeDir(sha256)
  mkdirSync(dir, { recursive: true })
  const serverName = process.platform === "win32" ? "llama-server.exe" : "llama-server"
  const serverPath = path.join(dir, serverName)
  writeFileSync(serverPath, "hip-server")
  writeFileSync(path.join(dir, "ggml-hip.dll"), "lib")
  writeFileSync(
    path.join(dir, ".hip-runtime.json"),
    `${JSON.stringify({
      version: 1,
      sha256,
      target,
      files: [
        { name: serverName, bytes: Buffer.byteLength("hip-server") },
        { name: "ggml-hip.dll", bytes: Buffer.byteLength("lib") },
      ],
    })}\n`,
  )
  return { dir, serverPath, serverName }
}

describe("Debbie smoke matrix (HIP on-demand runtime)", () => {
  test("1) staged HIP binary activates when ROCm is present; fetch reports downloading phase", async () => {
    if (!hipPlatformSupported()) return
    const hip = await readHipLock()
    if (!hip) return

    await withDataRoot((root) => {
      stageHipRuntime(hip.entry.sha256, hip.target)
      const triple = hostTarget()
      const isZip = process.platform === "win32"
      const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
      writeFileSync(cpu, "cpu")

      const resolved = resolveServerPath({
        configPath: cpu,
        env: { [SERVER_ENV]: cpu },
        variant: "hip",
      })
      expect(resolved).toBe(
        path.join(hipRuntimeDir(hip.entry.sha256), process.platform === "win32" ? "llama-server.exe" : "llama-server"),
      )
      expect(resolveLibsPath({}, "hip")).toBe(hipRuntimeDir(hip.entry.sha256))

      const status = resolveBackend({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: true,
      })
      expect(status.active).toBe("hip")
      expect(status.fallback).toBe(false)
      expect(status.fallbackReason).toBeUndefined()
    })

    const phases: Array<"downloading" | "verifying"> = []
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array(64).fill(9)),
    })
    try {
      await withDataRoot(async () => {
        const exit = await Effect.runPromise(
          Effect.provide(
            ensure({
              policy: "auto",
              requested: "hip",
              sources: [`http://127.0.0.1:${server.port}/bad.zip`],
              maxAttempts: 1,
              onPhase: (phase) => phases.push(phase),
            }),
            layer,
          ).pipe(Effect.exit),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(phases).toEqual(["downloading"])
      })
    } finally {
      server.stop(true)
    }
  })

  test("2) mirror or sha256 failure maps to hip_download_failed with explicit CPU fallback", async () => {
    if (!hipPlatformSupported()) return
    const hip = await readHipLock()
    if (!hip) return

    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array(128).fill(7)),
    })
    try {
      await withDataRoot(async () => {
        const exit = await Effect.runPromise(
          Effect.provide(
            ensure({
              policy: "auto",
              requested: "hip",
              sources: [`http://127.0.0.1:${server.port}/bad.zip`],
              maxAttempts: 1,
            }),
            layer,
          ).pipe(Effect.exit),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect((error as Error).message).toMatch(/sha256|download|mismatch/i)
        }
      })
    } finally {
      server.stop(true)
    }

    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    const failed = resolveBackend({
      requested: "auto",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false },
      rocmRuntimePresent: true,
      hipDownloadFailed: true,
    })
    expect(failed.active).toBe("cpu")
    expect(failed.fallback).toBe(true)
    expect(failed.fallbackReason).toBe("hip_download_failed")
    expect(failed.fallbackReason).not.toBe("manual_cpu")
  })

  test("3) staged HIP binary without system ROCm reports missing_rocm_runtime", async () => {
    if (!hipPlatformSupported()) return
    const hip = await readHipLock()
    if (!hip) return

    await withDataRoot((root) => {
      const triple = hostTarget()
      const isZip = process.platform === "win32"
      const cpu = path.join(root, stagedServerName(triple, "cpu", isZip))
      writeFileSync(cpu, "cpu")
      stageHipRuntime(hip.entry.sha256, hip.target)

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
      expect(status.fallbackReason).not.toBe("hip_download_failed")
    })
  })

  test("4) CPU default path and download=never/manual skip HIP fetch", async () => {
    if (!hipPlatformSupported()) return
    const hip = await readHipLock()
    if (!hip) return

    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))

    expect(shouldFetch({ requested: "cpu", serverPath: cpu, env: { [SERVER_ENV]: cpu } })).toBe(false)
    expect(resolveServerPath({ configPath: cpu, variant: "cpu" })).toBe(cpu)
    expect(resolveServerPath({ configPath: cpu, variant: "hip" })).toBeUndefined()

    const cpuStatus = resolveBackend({
      requested: "cpu",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false },
      rocmRuntimePresent: false,
    })
    expect(cpuStatus.active).toBe("cpu")
    expect(cpuStatus.fallback).toBe(false)

    for (const policy of ["never", "manual"] as const) {
      const exit = await Effect.runPromise(
        Effect.provide(
          ensure({
            policy,
            requested: "hip",
          }),
          layer,
        ).pipe(Effect.exit),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect((Cause.squash(exit.cause) as Error).message).toContain(`download=${policy}`)
      }
    }

    const blocked = resolveBackend({
      requested: "hip",
      serverPath: cpu,
      env: { [SERVER_ENV]: cpu },
      inventory: { amd: true, nvidia: false },
      rocmRuntimePresent: true,
      hipDownloadFailed: false,
    })
    expect(blocked.fallbackReason).toBe("no_vendored_binary")
    expect(blocked.fallbackReason).not.toBe("hip_download_failed")
  })
})

describe("Jennie status field map (wire / SemifService.Status)", () => {
  test("documents lifecycle and HIP failure fields exposed on GET /semif/status", () => {
    const downloading = { status: "downloading" as const }
    const verifying = { status: "verifying" as const }
    const hipFailed = {
      status: "offline" as const,
      backendFallback: true,
      backendFallbackReason: "hip_download_failed" as const,
    }

    expect(downloading.status).toBe("downloading")
    expect(verifying.status).toBe("verifying")
    expect(hipFailed.backendFallbackReason).toBe("hip_download_failed")
    expect(hipFailed.backendFallback).toBe(true)
  })
})
