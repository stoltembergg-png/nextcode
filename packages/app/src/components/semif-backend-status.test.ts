import { describe, expect, test } from "bun:test"
import type { SemifStatus } from "@opencode-ai/sdk/v2/client"
import {
  semifBackendDisplayState,
  semifBackendDotClass,
  semifBackendFallbackI18nKey,
  semifBackendMessageKey,
} from "./semif-backend-status"

const base = (): SemifStatus => ({
  status: "ready",
  mode: "auto",
  download: "auto",
  backend: "cpu",
  backendRequested: "auto",
  backendFallback: false,
  systemRuntimeMissing: false,
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices: [],
})

describe("semifBackendDisplayState", () => {
  test("reports HIP active when backend is hip without fallback", () => {
    expect(
      semifBackendDisplayState({
        ...base(),
        backend: "hip",
        backendFallback: false,
      }),
    ).toBe("hip_active")
  })

  test("reports system runtime missing before other states", () => {
    expect(
      semifBackendDisplayState({
        ...base(),
        backend: "cpu",
        backendFallback: true,
        backendFallbackReason: "missing_rocm_runtime",
        systemRuntimeMissing: true,
      }),
    ).toBe("system_runtime_missing")
  })

  test("reports CPU fallback when backendFallback is true", () => {
    expect(
      semifBackendDisplayState({
        ...base(),
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("cpu_fallback")
  })

  test("returns undefined when no backend state should be shown", () => {
    expect(semifBackendDisplayState(base())).toBeUndefined()
  })
})

describe("semifBackendFallbackI18nKey", () => {
  test("maps known fallback reasons to i18n keys", () => {
    expect(semifBackendFallbackI18nKey("no_vendored_binary")).toBe("semif.backend.fallback.no_vendored_binary")
    expect(semifBackendFallbackI18nKey("missing_rocm_runtime")).toBe("semif.backend.fallback.missing_rocm_runtime")
  })

  test("uses unknown key when reason is missing", () => {
    expect(semifBackendFallbackI18nKey()).toBe("semif.backend.fallback.unknown")
  })
})

describe("semifBackendMessageKey", () => {
  test("selects the HIP active message", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        backend: "hip",
        backendFallback: false,
      }),
    ).toBe("semif.backend.hip_active")
  })

  test("selects the system runtime message", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        backendFallback: true,
        backendFallbackReason: "missing_rocm_runtime",
        systemRuntimeMissing: true,
      }),
    ).toBe("semif.backend.system_runtime_missing")
  })

  test("selects fallback reason copy for vendored binary absence", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.backend.fallback.no_vendored_binary")
  })
})

describe("semifBackendDotClass", () => {
  test("uses success styling for active HIP", () => {
    expect(semifBackendDotClass("hip_active")).toBe("bg-icon-success-base")
  })

  test("uses warning styling for fallback and missing runtime", () => {
    expect(semifBackendDotClass("cpu_fallback")).toBe("bg-icon-warning-base")
    expect(semifBackendDotClass("system_runtime_missing")).toBe("bg-icon-warning-base")
  })
})
