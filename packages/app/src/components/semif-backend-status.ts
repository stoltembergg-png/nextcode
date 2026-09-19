import type { SemifStatus } from "@opencode-ai/sdk/v2/client"

export type SemifBackendDisplayState =
  | "hip_active"
  | "hip_fetch_in_progress"
  | "system_runtime_missing"
  | "gpu_unsupported"
  | "cpu_fallback"

type SemifBackendFallbackReason = NonNullable<SemifStatus["backendFallbackReason"]>

export function semifHipFetchInProgress(status: SemifStatus | undefined) {
  if (!status) return false
  if (status.backendFallbackReason === "gpu_unsupported") return false
  if (status.status !== "downloading" && status.status !== "verifying") return false
  if (status.backendRequested !== "auto" && status.backendRequested !== "hip") return false
  if (status.backend === "hip" && !status.backendFallback) return false
  if (status.backendFallbackReason === "no_vendored_binary") return true
  if (!status.backendFallback && !status.backendFallbackReason) return true
  return false
}

export function semifBackendDisplayState(status: SemifStatus | undefined): SemifBackendDisplayState | undefined {
  if (!status) return undefined
  if (status.systemRuntimeMissing) return "system_runtime_missing"
  if (semifHipFetchInProgress(status)) return "hip_fetch_in_progress"
  if (status.backend === "hip" && !status.backendFallback) return "hip_active"
  if (status.backendFallbackReason === "gpu_unsupported") return "gpu_unsupported"
  if (status.backendFallback) return "cpu_fallback"
  return undefined
}

export function semifBackendFallbackI18nKey(reason?: SemifBackendFallbackReason): string {
  if (!reason) return "semif.backend.fallback.unknown"
  return `semif.backend.fallback.${reason}`
}

export function semifBackendDotClass(state: SemifBackendDisplayState | undefined) {
  if (state === "hip_active") return "bg-icon-success-base"
  if (state === "hip_fetch_in_progress" || state === "system_runtime_missing" || state === "cpu_fallback")
    return "bg-icon-warning-base"
  if (state === "gpu_unsupported") return "bg-border-weak-base"
  return "bg-border-weak-base"
}

export function semifBackendMessageKey(status: SemifStatus | undefined) {
  if (semifHipFetchInProgress(status)) {
    if (status?.status === "verifying") return "semif.backend.hip_verifying"
    return "semif.backend.hip_downloading"
  }
  const state = semifBackendDisplayState(status)
  if (state === "hip_active") return "semif.backend.hip_active"
  if (state === "system_runtime_missing") return "semif.backend.system_runtime_missing"
  if (state === "gpu_unsupported") return semifBackendFallbackI18nKey("gpu_unsupported")
  if (state === "cpu_fallback") return semifBackendFallbackI18nKey(status?.backendFallbackReason)
  return undefined
}

export function semifLifecycleStatusKey(status: SemifStatus | undefined) {
  if (!status) return undefined
  if (semifHipFetchInProgress(status)) {
    if (status.status === "verifying") return "semif.state.verifying_hip_runtime"
    return "semif.state.downloading_hip_runtime"
  }
  if (status.status === "downloading") return "semif.state.downloading"
  if (status.status === "verifying") return "semif.state.verifying"
  return undefined
}
