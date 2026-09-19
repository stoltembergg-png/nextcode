import type { SemifStatus } from "@opencode-ai/sdk/v2/client"

export type SemifBackendDisplayState = "hip_active" | "system_runtime_missing" | "cpu_fallback"

type SemifBackendFallbackReason = NonNullable<SemifStatus["backendFallbackReason"]>

export function semifBackendDisplayState(status: SemifStatus | undefined): SemifBackendDisplayState | undefined {
  if (!status) return undefined
  if (status.systemRuntimeMissing) return "system_runtime_missing"
  if (status.backend === "hip" && !status.backendFallback) return "hip_active"
  if (status.backendFallback) return "cpu_fallback"
  return undefined
}

export function semifBackendFallbackI18nKey(reason?: SemifBackendFallbackReason): string {
  if (!reason) return "semif.backend.fallback.unknown"
  return `semif.backend.fallback.${reason}`
}

export function semifBackendDotClass(state: SemifBackendDisplayState | undefined) {
  if (state === "hip_active") return "bg-icon-success-base"
  if (state === "system_runtime_missing" || state === "cpu_fallback") return "bg-icon-warning-base"
  return "bg-border-weak-base"
}

export function semifBackendMessageKey(status: SemifStatus | undefined) {
  const state = semifBackendDisplayState(status)
  if (state === "hip_active") return "semif.backend.hip_active"
  if (state === "system_runtime_missing") return "semif.backend.system_runtime_missing"
  if (state === "cpu_fallback") return semifBackendFallbackI18nKey(status?.backendFallbackReason)
  return undefined
}
