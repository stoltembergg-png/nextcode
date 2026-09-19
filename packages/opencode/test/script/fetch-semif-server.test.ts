import { describe, expect, test } from "bun:test"
import {
  HOST_TARGETS,
  hostTarget,
  lockTargetKey,
  stagedLibsDir,
  stagedServerName,
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
})
