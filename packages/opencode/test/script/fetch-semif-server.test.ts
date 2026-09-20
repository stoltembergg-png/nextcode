import { describe, expect, test } from "bun:test"
import {
  downloadCandidates,
  embeddedLockfile,
  HOST_TARGETS,
  hostTarget,
  lockTargetKey,
  publishedMirrorUrl,
  readLockfile,
  stagedLibsDir,
  stagedServerName,
  type Lockfile,
  type TargetLock,
} from "../../script/fetch-semif-server"

describe("fetch-semif-server", () => {
  test("maps linux-x64 to the ubuntu gnu triple", () => {
    expect(HOST_TARGETS["linux-x64"]).toBe("x86_64-unknown-linux-gnu")
    expect(hostTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu")
  })

  test("preserves existing cpu lock keys", () => {
    expect(lockTargetKey("x86_64-pc-windows-msvc", "cpu")).toBe("x86_64-pc-windows-msvc")
    expect(lockTargetKey("aarch64-apple-darwin", "cpu")).toBe("aarch64-apple-darwin")
  })

  test("suffixes non-cpu variants without changing cpu staging names", () => {
    expect(lockTargetKey("x86_64-pc-windows-msvc", "hip")).toBe("x86_64-pc-windows-msvc-hip")
    expect(stagedServerName("x86_64-pc-windows-msvc", "cpu", true)).toBe("llama-server-x86_64-pc-windows-msvc.exe")
    expect(stagedServerName("x86_64-pc-windows-msvc", "hip", true)).toBe(
      "llama-server-x86_64-pc-windows-msvc-hip.exe",
    )
    expect(stagedServerName("x86_64-unknown-linux-gnu", "cpu", false)).toBe("llama-server-x86_64-unknown-linux-gnu")
  })

  test("stages hip libraries in a separate resource directory", () => {
    expect(stagedLibsDir("cpu")).toMatch(/\/semif$/)
    expect(stagedLibsDir("hip")).toMatch(/\/semif-hip$/)
  })

  test("suffixes vulkan lock keys and staging names", () => {
    expect(lockTargetKey("x86_64-pc-windows-msvc", "vulkan")).toBe("x86_64-pc-windows-msvc-vulkan")
    expect(stagedServerName("x86_64-pc-windows-msvc", "vulkan", true)).toBe(
      "llama-server-x86_64-pc-windows-msvc-vulkan.exe",
    )
    expect(stagedLibsDir("vulkan")).toMatch(/\/semif-vulkan$/)
  })

  test("embedded lockfile pins vulkan targets for windows and linux triples", () => {
    const lock = embeddedLockfile()
    const win = lock.targets["x86_64-pc-windows-msvc-vulkan"]
    const linux = lock.targets["x86_64-unknown-linux-gnu-vulkan"]
    expect(lock.tag).toBe("b11040")
    expect(win?.asset).toBe("llama-b11040-bin-win-vulkan-x64.zip")
    expect(linux?.asset).toBe("llama-b11040-bin-ubuntu-vulkan-x64.tar.gz")
    expect(win?.bytes).toBe(31821107)
    expect(linux?.bytes).toBe(30363623)
    expect(win?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(linux?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("embedded lockfile pins hip targets for the host triple", () => {
    const lock = embeddedLockfile()
    const hip = lock.targets[lockTargetKey(hostTarget(), "hip")]
    expect(lock.tag).toBeTruthy()
    expect(hip?.asset).toMatch(/hip|rocm/i)
    expect(typeof hip?.bytes).toBe("number")
    expect(hip?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("readLockfile resolves from the embedded lock without filesystem reads", async () => {
    const lock = await readLockfile()
    expect(lock).toBe(embeddedLockfile())
    expect(lock.targets[lockTargetKey(hostTarget(), "hip")]).toBeDefined()
  })

  test("builds published mirror urls from the lock target", () => {
    const lock: Lockfile = { tag: "b11040", targets: {} }
    const entry: TargetLock = {
      asset: "llama-b11040-bin-win-rocm-10.0-x64.zip",
      bytes: 1,
      sha256: "abc",
    }
    const target = "x86_64-pc-windows-msvc-hip"
    expect(publishedMirrorUrl(lock, target, entry)).toBe(
      "https://github.com/stoltembergg-png/nextcode/releases/download/semif-server-b11040/semif-server-b11040-x86_64-pc-windows-msvc-hip.zip",
    )
    expect(downloadCandidates(lock, target, entry)).toEqual([
      "https://github.com/stoltembergg-png/nextcode/releases/download/semif-server-b11040/semif-server-b11040-x86_64-pc-windows-msvc-hip.zip",
      "https://github.com/ggml-org/llama.cpp/releases/download/b11040/llama-b11040-bin-win-rocm-10.0-x64.zip",
    ])
    expect(downloadCandidates(lock, target, entry, { NEXTCODE_SEMIF_MIRROR: "https://mirror/example.zip" })).toEqual([
      "https://mirror/example.zip",
      "https://github.com/stoltembergg-png/nextcode/releases/download/semif-server-b11040/semif-server-b11040-x86_64-pc-windows-msvc-hip.zip",
      "https://github.com/ggml-org/llama.cpp/releases/download/b11040/llama-b11040-bin-win-rocm-10.0-x64.zip",
    ])
  })
})
