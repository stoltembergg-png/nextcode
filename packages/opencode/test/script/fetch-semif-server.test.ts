import { describe, expect, test } from "bun:test"
import {
  curlDownloadArgs,
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
  const posixPath = (value: string) => value.replaceAll("\\", "/")

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
    expect(posixPath(stagedLibsDir("cpu"))).toMatch(/\/semif$/)
    expect(posixPath(stagedLibsDir("hip"))).toMatch(/\/semif-hip$/)
  })

  test("suffixes vulkan lock keys and staging names", () => {
    expect(lockTargetKey("x86_64-pc-windows-msvc", "vulkan")).toBe("x86_64-pc-windows-msvc-vulkan")
    expect(stagedServerName("x86_64-pc-windows-msvc", "vulkan", true)).toBe(
      "llama-server-x86_64-pc-windows-msvc-vulkan.exe",
    )
    expect(posixPath(stagedLibsDir("vulkan"))).toMatch(/\/semif-vulkan$/)
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

  test("does not retry the unpublished dest url when it duplicates the published mirror", () => {
    const lock: Lockfile = { tag: "b11040", targets: {} }
    const entry: TargetLock = {
      asset: "llama-b11040-bin-win-vulkan-x64.zip",
      bytes: 1,
      sha256: "abc",
    }
    const target = "x86_64-pc-windows-msvc-vulkan"
    const dest =
      "https://github.com/stoltembergg-png/nextcode/releases/download/semif-server-b11040/semif-server-b11040-x86_64-pc-windows-msvc-vulkan.zip"
    expect(publishedMirrorUrl(lock, target, entry)).toBe(dest)
    expect(downloadCandidates(lock, target, entry, { NEXTCODE_SEMIF_MIRROR: dest })).toEqual([
      dest,
      "https://github.com/ggml-org/llama.cpp/releases/download/b11040/llama-b11040-bin-win-vulkan-x64.zip",
    ])
  })

  test("upstream-only skips dest mirror urls that do not exist yet", () => {
    const lock: Lockfile = { tag: "b11040", targets: {} }
    const entry: TargetLock = {
      asset: "llama-b11040-bin-win-vulkan-x64.zip",
      bytes: 1,
      sha256: "abc",
    }
    const dest =
      "https://github.com/stoltembergg-png/nextcode/releases/download/semif-server-b11040/semif-server-b11040-x86_64-pc-windows-msvc-vulkan.zip"
    expect(
      downloadCandidates(lock, "x86_64-pc-windows-msvc-vulkan", entry, {
        NEXTCODE_SEMIF_MIRROR: dest,
        NEXTCODE_SEMIF_UPSTREAM_ONLY: "1",
      }),
    ).toEqual(["https://github.com/ggml-org/llama.cpp/releases/download/b11040/llama-b11040-bin-win-vulkan-x64.zip"])
  })

  test("curl download forces IPv4, follows redirects, and bounds wall time", () => {
    expect(curlDownloadArgs("/tmp/llama.zip", "https://example.com/llama.zip")).toEqual([
      "-fL",
      "-4",
      "--retry",
      "3",
      "--retry-delay",
      "2",
      "--max-time",
      "300",
      "--progress-bar",
      "-o",
      "/tmp/llama.zip",
      "https://example.com/llama.zip",
    ])
  })
})
