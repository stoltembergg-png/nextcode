import { describe, expect, test } from "bun:test"
import type { SemifStatus } from "@opencode-ai/sdk/v2/client"
import {
  semifBackendDisplayState,
  semifBackendDotClass,
  semifBackendFallbackI18nKey,
  semifBackendMessageKey,
  semifHipFetchInProgress,
  semifLifecycleStatusKey,
  semifVulkanFetchInProgress,
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

describe("semifHipFetchInProgress", () => {
  test("detects HIP fetch while downloading without a vendored binary", () => {
    expect(
      semifHipFetchInProgress({
        ...base(),
        status: "downloading",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
        backendRequested: "auto",
      }),
    ).toBe(true)
  })

  test("detects HIP fetch when backend clears fallback during download", () => {
    expect(
      semifHipFetchInProgress({
        ...base(),
        status: "downloading",
        backendFallback: false,
        backendRequested: "hip",
      }),
    ).toBe(true)
  })

  test("detects HIP fetch while verifying with hip backend requested", () => {
    expect(
      semifHipFetchInProgress({
        ...base(),
        status: "verifying",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
        backendRequested: "hip",
      }),
    ).toBe(true)
  })

  test("ignores model download when HIP binary is already available", () => {
    expect(
      semifHipFetchInProgress({
        ...base(),
        status: "downloading",
        backend: "hip",
        backendFallback: false,
      }),
    ).toBe(false)
  })

  test("ignores idle no_vendored_binary fallback", () => {
    expect(
      semifHipFetchInProgress({
        ...base(),
        status: "offline",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe(false)
  })
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

  test("reports HIP fetch in progress before other fallback states", () => {
    expect(
      semifBackendDisplayState({
        ...base(),
        status: "downloading",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("hip_fetch_in_progress")
  })

  test("reports HIP fetch in progress when backend clears fallback mid-download", () => {
    expect(
      semifBackendDisplayState({
        ...base(),
        status: "verifying",
        backendFallback: false,
        backendRequested: "auto",
      }),
    ).toBe("hip_fetch_in_progress")
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

  test("reports gpu_unsupported separately from download-related fallbacks", () => {
    expect(
      semifBackendDisplayState({
        ...base(),
        backendFallback: true,
        backendFallbackReason: "gpu_unsupported",
      }),
    ).toBe("gpu_unsupported")
  })

  test("returns undefined when no backend state should be shown", () => {
    expect(semifBackendDisplayState(base())).toBeUndefined()
  })
})

describe("semifBackendFallbackI18nKey", () => {
  test("maps known fallback reasons to i18n keys", () => {
    expect(semifBackendFallbackI18nKey("no_vendored_binary")).toBe("semif.backend.fallback.no_vendored_binary")
    expect(semifBackendFallbackI18nKey("missing_rocm_runtime")).toBe("semif.backend.fallback.missing_rocm_runtime")
    expect(semifBackendFallbackI18nKey("hip_download_failed")).toBe("semif.backend.fallback.hip_download_failed")
    expect(semifBackendFallbackI18nKey("gpu_unsupported")).toBe("semif.backend.fallback.gpu_unsupported")
    expect(semifBackendFallbackI18nKey("missing_vulkan_runtime")).toBe("semif.backend.fallback.missing_vulkan_runtime")
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

  test("selects HIP fetch copy while downloading without a vendored binary", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        status: "downloading",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.backend.hip_downloading")
  })

  test("selects HIP fetch copy while backend clears fallback during download", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        status: "downloading",
        backendFallback: false,
        backendRequested: "hip",
      }),
    ).toBe("semif.backend.hip_downloading")
  })

  test("selects HIP fetch copy while verifying without a vendored binary", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        status: "verifying",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.backend.hip_verifying")
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

  test("selects Vulkan loader copy when the ICD is missing", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        backendFallback: true,
        backendFallbackReason: "missing_vulkan_runtime",
        systemRuntimeMissing: true,
      }),
    ).toBe("semif.backend.fallback.missing_vulkan_runtime")
  })

  test("selects fallback reason copy for vendored binary absence when idle", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        status: "offline",
        backendRequested: "hip",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.backend.fallback.no_vendored_binary")
  })

  test("selects Vulkan vendored-binary copy for auto idle CPU fallback", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        status: "offline",
        backend: "cpu",
        backendRequested: "auto",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.backend.fallback.no_vendored_binary_vulkan")
    expect(
      semifBackendFallbackI18nKey("no_vendored_binary", {
        ...base(),
        backend: "cpu",
        backendRequested: "vulkan",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.backend.fallback.no_vendored_binary_vulkan")
  })

  test("selects fallback reason copy for HIP download failure", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        backendFallback: true,
        backendFallbackReason: "hip_download_failed",
      }),
    ).toBe("semif.backend.fallback.hip_download_failed")
  })

  test("selects gpu_unsupported copy instead of HIP fetch messaging", () => {
    expect(
      semifBackendMessageKey({
        ...base(),
        status: "downloading",
        backendFallback: true,
        backendFallbackReason: "gpu_unsupported",
      }),
    ).toBe("semif.backend.fallback.gpu_unsupported")
    expect(
      semifHipFetchInProgress({
        ...base(),
        status: "downloading",
        backendFallback: true,
        backendFallbackReason: "gpu_unsupported",
      }),
    ).toBe(false)
  })
})

describe("semifLifecycleStatusKey", () => {
  test("refines downloading lifecycle copy during HIP fetch", () => {
    expect(
      semifLifecycleStatusKey({
        ...base(),
        status: "downloading",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.state.downloading_hip_runtime")
  })

  test("refines verifying lifecycle copy during HIP fetch", () => {
    expect(
      semifLifecycleStatusKey({
        ...base(),
        status: "verifying",
        backendFallback: true,
        backendFallbackReason: "no_vendored_binary",
      }),
    ).toBe("semif.state.verifying_hip_runtime")
  })

  test("refines lifecycle copy when backend clears fallback mid-fetch", () => {
    expect(
      semifLifecycleStatusKey({
        ...base(),
        status: "verifying",
        backendFallback: false,
        backendRequested: "auto",
      }),
    ).toBe("semif.state.verifying_hip_runtime")
  })

  test("keeps model download lifecycle copy when HIP binary is present", () => {
    expect(
      semifLifecycleStatusKey({
        ...base(),
        status: "downloading",
        backend: "hip",
        backendFallback: false,
      }),
    ).toBe("semif.state.downloading")
  })
})

describe("semifVulkanFetchInProgress", () => {
  test("detects vulkan fetch in progress", () => {
    expect(
      semifVulkanFetchInProgress({
        ...base(),
        status: "downloading",
        backend: "cpu",
        backendRequested: "auto",
        backendFallback: false,
      }),
    ).toBe(true)
  })

  test("auto Vulkan warmup copy wins over HIP when the fetch message is Vulkan", () => {
    const snapshot = {
      ...base(),
      status: "downloading" as const,
      backend: "cpu" as const,
      backendRequested: "auto" as const,
      backendFallback: false,
      backendMessage: "semif: fetching Vulkan runtime",
    }
    expect(semifHipFetchInProgress(snapshot)).toBe(true)
    expect(semifVulkanFetchInProgress(snapshot)).toBe(true)
    expect(semifBackendDisplayState(snapshot)).toBe("vulkan_fetch_in_progress")
    expect(semifBackendMessageKey(snapshot)).toBe("semif.backend.vulkan_downloading")
    expect(semifLifecycleStatusKey(snapshot)).toBe("semif.state.downloading_vulkan_runtime")
  })

  test("gpu_unsupported hip fetch is still skipped", () => {
    expect(
      semifHipFetchInProgress({
        ...base(),
        status: "downloading",
        backendFallbackReason: "gpu_unsupported",
        backendRequested: "hip",
      }),
    ).toBe(false)
  })

  test("auto HIP/ROCm fetch keeps HIP copy when the message is not Vulkan", () => {
    const snapshot = {
      ...base(),
      status: "downloading" as const,
      backend: "cpu" as const,
      backendRequested: "auto" as const,
      backendFallback: false,
      backendMessage: "semif: fetching HIP runtime",
    }
    expect(semifHipFetchInProgress(snapshot)).toBe(true)
    expect(semifVulkanFetchInProgress(snapshot)).toBe(true)
    expect(semifBackendDisplayState(snapshot)).toBe("hip_fetch_in_progress")
    expect(semifBackendMessageKey(snapshot)).toBe("semif.backend.hip_downloading")
    expect(semifLifecycleStatusKey(snapshot)).toBe("semif.state.downloading_hip_runtime")
  })
})

describe("semifBackendDisplayState vulkan", () => {
  test("reports vulkan active", () => {
    expect(
      semifBackendDisplayState({
        ...base(),
        backend: "vulkan",
        backendRequested: "auto",
        backendFallback: false,
      }),
    ).toBe("vulkan_active")
    expect(semifBackendMessageKey({ ...base(), backend: "vulkan", backendFallback: false })).toBe(
      "semif.backend.vulkan_active",
    )
    expect(semifBackendDotClass("vulkan_active")).toBe("bg-icon-success-base")
  })
})

describe("semifBackendDotClass", () => {
  test("uses success styling for active HIP", () => {
    expect(semifBackendDotClass("hip_active")).toBe("bg-icon-success-base")
  })

  test("uses warning styling for HIP fetch, fallback, and missing runtime", () => {
    expect(semifBackendDotClass("hip_fetch_in_progress")).toBe("bg-icon-warning-base")
    expect(semifBackendDotClass("cpu_fallback")).toBe("bg-icon-warning-base")
    expect(semifBackendDotClass("system_runtime_missing")).toBe("bg-icon-warning-base")
  })

  test("uses neutral styling for gpu_unsupported", () => {
    expect(semifBackendDotClass("gpu_unsupported")).toBe("bg-border-weak-base")
  })
})
