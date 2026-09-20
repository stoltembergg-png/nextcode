import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { Cause, Effect, Exit, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { embeddedRocmLock, runtimeStageKey, stageWheelsToDir } from "../../script/fetch-rocm-runtime"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"
import { resolveBackend } from "../../src/semif/backend"
import { GFX_ENV, unsupportedGfx } from "../../src/semif/gfx"
import { shouldFetch as shouldFetchHip } from "../../src/semif/hip-runtime"
import { ensure, shouldFetch } from "../../src/semif/rocm-runtime"
import { hipRuntimeDir, rocmRuntimeDir, SERVER_ENV } from "../../src/semif/paths"
import { readHipLock } from "../../src/semif/hip-runtime"
import { $ } from "bun"

const layer = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)

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

const withDataRoot = (run: (root: string) => void | Promise<void>) => {
  const root = mkdtempSync(path.join(tmpdir(), "semif-rocm-runtime-"))
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
  writeFileSync(path.join(dir, serverName), "hip-server")
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
}

describe("semif rocm runtime", () => {
  test("shouldFetch is false without gfx and true when HIP is staged on Windows", async () => {
    if (process.platform !== "win32") return
    const hip = await readHipLock()
    if (!hip) return
    const triple = hostTarget()
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", true))
    expect(
      shouldFetch({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
      }),
    ).toBe(false)
    await withDataRoot(() => {
      stageHipRuntime(hip.entry.sha256, hip.target)
      expect(
        shouldFetch({
          requested: "hip",
          serverPath: cpu,
          env: { [SERVER_ENV]: cpu, [GFX_ENV]: "gfx1100" },
          inventory: { amd: true, nvidia: false },
        }),
      ).toBe(true)
    })
  })

  test("ensure reuses a staged ROCm runtime directory", async () => {
    if (process.platform !== "win32") return
    const lock = embeddedRocmLock()
    const gfx = "gfx1100"
    await withDataRoot(async (root) => {
      const dir = rocmRuntimeDir(runtimeStageKey(lock, gfx))
      const core = path.join(root, "core.whl")
      const libraries = path.join(root, "libraries.whl")
      const device = path.join(root, "device.whl")
      await writeWheel(core, { "_rocm_sdk_core/bin/amdhip64_7.dll": "core" })
      await writeWheel(libraries, {
        "_rocm_sdk_libraries/bin/hipblas.dll": "hipblas",
        "_rocm_sdk_libraries/bin/rocblas.dll": "rocblas",
        "_rocm_sdk_libraries/bin/rocblas/library/kernel.dat": "kernel",
      })
      await writeWheel(device, {
        "_rocm_sdk_libraries/bin/hipblaslt/library/gfx1100/kernel.dat": "hipblaslt",
      })
      await stageWheelsToDir([{ archive: core }, { archive: libraries }, { archive: device }], dir)
      writeFileSync(
        path.join(dir, ".rocm-runtime.json"),
        `${JSON.stringify({
          version: 1,
          gfx,
          rocmVersion: lock.version,
          files: [
            { name: "bin/amdhip64_7.dll", bytes: Buffer.byteLength("core") },
            { name: "bin/hipblas.dll", bytes: Buffer.byteLength("hipblas") },
            { name: "bin/rocblas.dll", bytes: Buffer.byteLength("rocblas") },
            { name: "rocblas/library/kernel.dat", bytes: Buffer.byteLength("kernel") },
            { name: "hipblaslt/library/gfx1100/kernel.dat", bytes: Buffer.byteLength("hipblaslt") },
          ],
        })}\n`,
      )
      const result = await Effect.runPromise(
        Effect.provide(
          ensure({
            policy: "auto",
            requested: "hip",
            env: { [GFX_ENV]: gfx },
          }),
          layer,
        ),
      )
      expect(result.acquired).toBe(false)
      expect(result.gfx).toBe(gfx)
      expect(result.rocblasLibraryDir).toBe(path.join(dir, "rocblas", "library"))
    })
  })

  test("windows supported gfx does not settle missing_rocm_runtime before fetch", async () => {
    if (process.platform !== "win32") return
    const hip = await readHipLock()
    if (!hip) return
    await withDataRoot((root) => {
      const triple = hostTarget()
      const cpu = path.join(root, stagedServerName(triple, "cpu", true))
      writeFileSync(cpu, "cpu")
      stageHipRuntime(hip.entry.sha256, hip.target)
      const status = resolveBackend({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu, [GFX_ENV]: "gfx1100" },
        inventory: { amd: true, nvidia: false },
        rocmRuntimePresent: false,
      })
      expect(status.fallbackReason).not.toBe("missing_rocm_runtime")
      expect(status.message).toContain("not staged")
    })
  })

  test("gfx803 short-circuits before any ROCm wheel fetch", () => {
    if (process.platform !== "win32") return
    const triple = hostTarget()
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", true))
    const env = { [GFX_ENV]: "gfx803" }
    expect(unsupportedGfx(env)).toBe("gfx803")
    expect(shouldFetch({ requested: "hip", serverPath: cpu, env, inventory: { amd: true, nvidia: false } })).toBe(false)
    expect(shouldFetchHip({ requested: "hip", serverPath: cpu, env, inventory: { amd: true, nvidia: false } })).toBe(
      false,
    )
  })

  test("download failure maps to hip_download_failed", async () => {
    if (process.platform !== "win32") return
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array(32).fill(1)),
    })
    try {
      await withDataRoot(async () => {
        const exit = await Effect.runPromise(
          Effect.provide(
            ensure({
              policy: "auto",
              requested: "hip",
              env: { [GFX_ENV]: "gfx1100" },
              sources: {
                core: [`http://127.0.0.1:${server.port}/core.whl`],
                libraries: [`http://127.0.0.1:${server.port}/libraries.whl`],
                device: [`http://127.0.0.1:${server.port}/device.whl`],
              },
              maxAttempts: 1,
            }),
            layer,
          ).pipe(Effect.exit),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect((Cause.squash(exit.cause) as Error).message).toMatch(/sha256|mismatch|download/i)
        }
      })
    } finally {
      server.stop(true)
    }
  })
})
