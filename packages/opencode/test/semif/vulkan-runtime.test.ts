import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { Cause, Exit, Layer, Effect } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { hipPlatformSupported } from "../../src/semif/backend"
import { ensure, readVulkanLock, shouldFetch } from "../../src/semif/vulkan-runtime"
import { SERVER_ENV, vulkanRuntimeDir } from "../../src/semif/paths"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"

const layer = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)

describe("semif vulkan runtime", () => {
  test("shouldFetch is true for auto when HIP rejects gfx803 and vulkan is not staged", () => {
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    expect(
      shouldFetch({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
        loaderPresent: true,
      }),
    ).toBe(hipPlatformSupported())
  })

  test("shouldFetch is false when the Vulkan loader is missing", () => {
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    expect(
      shouldFetch({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
        loaderPresent: false,
      }),
    ).toBe(false)
  })

  test("shouldFetch is false for auto on gfx1030", () => {
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    expect(
      shouldFetch({
        requested: "auto",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx1030" },
      }),
    ).toBe(false)
  })

  test("shouldFetch is false for explicit hip even on gfx803", () => {
    const triple = hostTarget()
    const isZip = process.platform === "win32"
    const cpu = path.join("/bundle", stagedServerName(triple, "cpu", isZip))
    expect(
      shouldFetch({
        requested: "hip",
        serverPath: cpu,
        env: { [SERVER_ENV]: cpu },
        inventory: { amd: true, nvidia: false, amdGfx: "gfx803" },
      }),
    ).toBe(false)
  })

  test("ensure rejects manual download policy when Vulkan runtime is not staged", async () => {
    const vulkan = await readVulkanLock()
    if (!vulkan) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-vulkan-runtime-manual-"))
    const previousData = Global.Path.data
    Object.assign(Global.Path, { data: root })
    try {
      const exit = await Effect.runPromise(
        Effect.provide(
          ensure({
            policy: "manual",
            requested: "vulkan",
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

  test("ensure reuses a staged Vulkan runtime directory", async () => {
    const vulkan = await readVulkanLock()
    if (!vulkan) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-vulkan-runtime-staged-"))
    const previousData = Global.Path.data
    Object.assign(Global.Path, { data: root })
    const dir = vulkanRuntimeDir(vulkan.entry.sha256)
    mkdirSync(dir, { recursive: true })
    const serverName = process.platform === "win32" ? "llama-server.exe" : "llama-server"
    const serverPath = path.join(dir, serverName)
    writeFileSync(serverPath, "vulkan-server")
    writeFileSync(path.join(dir, "ggml-vulkan.dll"), "lib")
    writeFileSync(
      path.join(dir, ".vulkan-runtime.json"),
      `${JSON.stringify({
        version: 1,
        sha256: vulkan.entry.sha256,
        target: vulkan.target,
        files: [
          { name: serverName, bytes: Buffer.byteLength("vulkan-server") },
          { name: "ggml-vulkan.dll", bytes: Buffer.byteLength("lib") },
        ],
      })}\n`,
    )
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          ensure({
            policy: "auto",
            requested: "vulkan",
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
