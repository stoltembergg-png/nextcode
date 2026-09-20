import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { Global } from "@opencode-ai/core/global"
import { hipPlatformSupported } from "../../src/semif/backend"
import { readHipLock } from "../../src/semif/hip-runtime"
import { readVulkanLock } from "../../src/semif/vulkan-runtime"
import {
  LIBS_ENV,
  LIBS_VULKAN_ENV,
  SERVER_ENV,
  SERVER_ENV_FALLBACK,
  downloadsRoot,
  modelDir,
  modelPath,
  partPath,
  resolveLibsPath,
  resolveModelPath,
  resolveServerPath,
  hipRuntimeDir,
  hipRuntimeMarkerPath,
  pinnedHipSha256,
  pinnedVulkanSha256,
  vulkanRuntimeDir,
  vulkanRuntimeMarkerPath,
  runtimeDir,
  runtimeRoot,
  serverBinaryName,
} from "../../src/semif/paths"

const HASH = "a4d000c7064bd3b2e42c6845836286a899a4e79cf1791da1a6797b58d575957d"

describe("semif paths", () => {
  test("server path precedence is config > env > dev", () => {
    const dev = import.meta.path
    expect(
      resolveServerPath({
        configPath: "/cfg/llama-server",
        env: { [SERVER_ENV]: "/env/llama-server" },
        devFallback: dev,
      }),
    ).toBe("/cfg/llama-server")
    expect(resolveServerPath({ env: { [SERVER_ENV]: "/env/llama-server" }, devFallback: dev })).toBe(
      "/env/llama-server",
    )
    expect(resolveServerPath({ env: { [SERVER_ENV_FALLBACK]: "/legacy/llama-server" }, devFallback: dev })).toBe(
      "/legacy/llama-server",
    )
    expect(resolveServerPath({ env: {}, devFallback: dev })).toBe(dev)
  })

  test("server path is absent without error when nothing resolves or exists", () => {
    expect(resolveServerPath({ env: {}, devFallback: path.join(Global.Path.tmp, "semif-missing-server") })).toBe(
      undefined,
    )
    expect(resolveServerPath({ env: {} })).toBe(undefined)
  })

  test("blank config and env values are treated as absent", () => {
    expect(resolveServerPath({ configPath: "   ", env: {}, devFallback: import.meta.path })).toBe(import.meta.path)
    expect(resolveServerPath({ env: { [SERVER_ENV]: "  " }, devFallback: import.meta.path })).toBe(import.meta.path)
  })

  test("model path prefers config over the hash registry", () => {
    expect(resolveModelPath({ configPath: "/models/custom.gguf", sha256: HASH, filename: "LFM2.gguf" })).toBe(
      "/models/custom.gguf",
    )
    expect(resolveModelPath({ sha256: HASH, filename: "LFM2.gguf" })).toBe(modelPath(HASH, "LFM2.gguf"))
  })

  test("registry and cache layouts are global and hash-keyed", () => {
    expect(modelDir(HASH)).toBe(path.join(Global.Path.data, "semif", "models", HASH.slice(0, 12)))
    expect(modelPath(HASH, "LFM2-350M-Q4_K_M.gguf")).toBe(
      path.join(Global.Path.data, "semif", "models", HASH.slice(0, 12), "LFM2-350M-Q4_K_M.gguf"),
    )
    expect(downloadsRoot()).toBe(path.join(Global.Path.cache, "semif", "downloads"))
    expect(partPath(HASH)).toBe(path.join(Global.Path.cache, "semif", "downloads", `${HASH}.part`))
  })

  test("runtime layout lives under data and is keyed by content", () => {
    expect(runtimeRoot()).toBe(path.join(Global.Path.data, "semif", "runtime"))
    expect(runtimeDir("abc123")).toBe(path.join(Global.Path.data, "semif", "runtime", "abc123"))
    expect(hipRuntimeDir(HASH)).toBe(path.join(Global.Path.data, "semif", "runtime", `hip-${HASH.slice(0, 12)}`))
    expect(hipRuntimeMarkerPath(HASH)).toBe(
      path.join(Global.Path.data, "semif", "runtime", `hip-${HASH.slice(0, 12)}`, ".hip-runtime.json"),
    )
    expect(vulkanRuntimeDir(HASH)).toBe(path.join(Global.Path.data, "semif", "runtime", `vulkan-${HASH.slice(0, 12)}`))
    expect(vulkanRuntimeMarkerPath(HASH)).toBe(
      path.join(Global.Path.data, "semif", "runtime", `vulkan-${HASH.slice(0, 12)}`, ".vulkan-runtime.json"),
    )
  })

  test("libs path comes from the dedicated launcher env and ignores blanks", () => {
    expect(resolveLibsPath({ [LIBS_ENV]: "/resources/semif" })).toBe("/resources/semif")
    expect(resolveLibsPath({ [LIBS_ENV]: "   " })).toBe(undefined)
    expect(resolveLibsPath({})).toBe(undefined)
  })

  test("staged HIP path resolves only the lock-pinned hip-<sha12> directory", async () => {
    if (!hipPlatformSupported()) return
    const hip = await readHipLock()
    if (!hip) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-paths-hip-lock-"))
    const previousData = Global.Path.data
    Object.assign(Global.Path, { data: root })
    const stale = hipRuntimeDir("0000000000000000000000000000000000000000000000000000000000000001")
    const current = hipRuntimeDir(hip.entry.sha256)
    mkdirSync(stale, { recursive: true })
    mkdirSync(current, { recursive: true })
    writeFileSync(path.join(stale, serverBinaryName()), "stale")
    writeFileSync(path.join(current, serverBinaryName()), "current")
    writeFileSync(path.join(current, ".hip-runtime.json"), "{}")
    try {
      expect(pinnedHipSha256()).toBe(hip.entry.sha256)
      expect(resolveServerPath({ variant: "hip" })).toBe(path.join(current, serverBinaryName()))
      expect(resolveLibsPath({}, "hip")).toBe(current)
    } finally {
      Object.assign(Global.Path, { data: previousData })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hip server and libs paths prefer hip-specific locations", () => {
    const cpu = "/bundle/llama-server-x86_64-pc-windows-msvc.exe"
    const hip = "/bundle/llama-server-x86_64-pc-windows-msvc-hip.exe"
    expect(resolveServerPath({ configPath: hip, variant: "hip" })).toBe(hip)
    expect(resolveServerPath({ configPath: cpu, variant: "hip", env: { [SERVER_ENV]: cpu } })).toBeUndefined()
    expect(resolveLibsPath({ NEXTCODE_SEMIF_HIP_LIBS_PATH: "/resources/semif-hip" }, "hip")).toBe("/resources/semif-hip")
  })

  test("staged Vulkan path resolves only the lock-pinned vulkan-<sha12> directory", async () => {
    if (!hipPlatformSupported()) return
    const vulkan = await readVulkanLock()
    if (!vulkan) return
    const root = mkdtempSync(path.join(tmpdir(), "semif-paths-vulkan-lock-"))
    const previousData = Global.Path.data
    Object.assign(Global.Path, { data: root })
    const stale = vulkanRuntimeDir("0000000000000000000000000000000000000000000000000000000000000001")
    const current = vulkanRuntimeDir(vulkan.entry.sha256)
    mkdirSync(stale, { recursive: true })
    mkdirSync(current, { recursive: true })
    writeFileSync(path.join(stale, serverBinaryName()), "stale")
    writeFileSync(path.join(current, serverBinaryName()), "current")
    writeFileSync(path.join(current, ".vulkan-runtime.json"), "{}")
    try {
      expect(pinnedVulkanSha256()).toBe(vulkan.entry.sha256)
      expect(resolveServerPath({ variant: "vulkan" })).toBe(path.join(current, serverBinaryName()))
      expect(resolveLibsPath({}, "vulkan")).toBe(current)
    } finally {
      Object.assign(Global.Path, { data: previousData })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("vulkan server and libs paths prefer vulkan-specific locations", () => {
    const cpu = "/bundle/llama-server-x86_64-pc-windows-msvc.exe"
    const vulkan = "/bundle/llama-server-x86_64-pc-windows-msvc-vulkan.exe"
    expect(resolveServerPath({ configPath: vulkan, variant: "vulkan" })).toBe(vulkan)
    expect(resolveServerPath({ configPath: cpu, variant: "vulkan", env: { [SERVER_ENV]: cpu } })).toBeUndefined()
    expect(resolveLibsPath({ [LIBS_VULKAN_ENV]: "/resources/semif-vulkan" }, "vulkan")).toBe("/resources/semif-vulkan")
  })
})
