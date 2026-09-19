import { describe, expect, test } from "bun:test"
import { resolveBackend } from "../../src/semif/backend"
import { GFX_ENV, isSupportedGfx, readAmdGfx, resolveSupportedGfx, unsupportedGfx } from "../../src/semif/gfx"
import { shouldFetch as shouldFetchHip } from "../../src/semif/hip-runtime"
import { shouldFetch as shouldFetchRocm } from "../../src/semif/rocm-runtime"
import { hostTarget, stagedServerName } from "../../script/fetch-semif-server"

describe("semif gfx", () => {
  test("pinned gfx families are supported and gfx803 is unsupported in the lock matrix", () => {
    for (const gfx of ["gfx1030", "gfx1100", "gfx1150", "gfx1200"]) {
      expect(isSupportedGfx(gfx)).toBe(true)
      expect(resolveSupportedGfx({ [GFX_ENV]: gfx })).toBe(gfx)
    }
    expect(isSupportedGfx("gfx803")).toBe(false)
    expect(resolveSupportedGfx({ [GFX_ENV]: "gfx803" })).toBeUndefined()
    expect(unsupportedGfx({ [GFX_ENV]: "gfx803" })).toBe("gfx803")
  })

  test("gfx override is read before vendor fetch", () => {
    expect(readAmdGfx({ [GFX_ENV]: "gfx803" })).toBe("gfx803")
  })

  test("gpu_unsupported is evaluated before vendor HIP or ROCm fetch gates", () => {
    if (process.platform !== "win32") return
    const triple = hostTarget()
    const cpu = `/bundle/${stagedServerName(triple, "cpu", true)}`
    const env = { [GFX_ENV]: "gfx803" }
    expect(shouldFetchHip({ requested: "hip", serverPath: cpu, env, inventory: { amd: true, nvidia: false } })).toBe(
      false,
    )
    expect(shouldFetchRocm({ requested: "hip", serverPath: cpu, env, inventory: { amd: true, nvidia: false } })).toBe(
      false,
    )
    const status = resolveBackend({
      requested: "hip",
      serverPath: cpu,
      env,
      inventory: { amd: true, nvidia: false },
      rocmRuntimePresent: false,
    })
    expect(status.fallbackReason).toBe("gpu_unsupported")
  })
})
