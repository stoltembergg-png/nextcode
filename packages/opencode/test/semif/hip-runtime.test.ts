import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { Cause, Exit, Layer, Effect } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { ensure, readHipLock, shouldFetch } from "../../src/semif/hip-runtime"
import { hipRuntimeDir, SERVER_ENV } from "../../src/semif/paths"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"

const layer = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)

describe("semif hip runtime", () => {
  test("shouldFetch is false when win hip matrix rejects the probed amd gfx", () => {
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    const inventory = { amd: true, nvidia: false, amdGfx: "gfx803" }
    if (process.platform === "win32") {
      expect(
        shouldFetch({
          requested: "hip",
          serverPath: cpu,
          env: { [SERVER_ENV]: cpu },
          inventory,
        }),
      ).toBe(false)
      return
    }
    expect(
      shouldFetch({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory,
      }),
    ).toBe(true)
  })

  test("shouldFetch is false for cpu preference and true for hip without vendored binary", () => {
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    expect(shouldFetch({ requested: "cpu", serverPath: cpu, env: { [SERVER_ENV]: cpu } })).toBe(false)
    expect(
      shouldFetch({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false },
      }),
    ).toBe(true)
  })

  test("ensure rejects manual download policy when HIP runtime is not staged", async () => {
    const hip = await readHipLock()
    if (!hip) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-hip-runtime-manual-"))
    const previousData = Global.Path.data
    Object.assign(Global.Path, { data: root })
    try {
      const exit = await Effect.runPromise(
        Effect.provide(
          ensure({
            policy: "manual",
            requested: "hip",
          }),
          layer,
        ).pipe(Effect.exit),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("download=manual")
      }
    } finally {
      Object.assign(Global.Path, { data: previousData })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("ensure reuses a staged HIP runtime directory", async () => {
    const hip = await readHipLock()
    if (!hip) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-hip-runtime-staged-"))
    const previousData = Global.Path.data
    Object.assign(Global.Path, { data: root })
    const dir = hipRuntimeDir(hip.entry.sha256)
    mkdirSync(dir, { recursive: true })
    const serverName = process.platform === "win32" ? "llama-server.exe" : "llama-server"
    const serverPath = path.join(dir, serverName)
    writeFileSync(serverPath, "hip-server")
    writeFileSync(path.join(dir, "ggml-hip.dll"), "lib")
    writeFileSync(
      path.join(dir, ".hip-runtime.json"),
      `${JSON.stringify({
        version: 1,
        sha256: hip.entry.sha256,
        target: hip.target,
        files: [
          { name: serverName, bytes: Buffer.byteLength("hip-server") },
          { name: "ggml-hip.dll", bytes: Buffer.byteLength("lib") },
        ],
      })}\n`,
    )
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          ensure({
            policy: "auto",
            requested: "hip",
          }),
          layer,
        ),
      )
      expect(result.acquired).toBe(false)
      expect(result.serverPath).toBe(serverPath)
      expect(result.libsPath).toBe(dir)
    } finally {
      Object.assign(Global.Path, { data: previousData })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
