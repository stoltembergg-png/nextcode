export type OmoDelegateState = "running" | "completed" | "error"

export type OmoDelegateSource = "semif" | "deterministic" | "explicit"

export type OmoDelegateView = {
  childID?: string
  state: OmoDelegateState
  agent?: string
  background?: boolean
  verification?: string
  source?: OmoDelegateSource
  fallbackReason?: string
  downgraded?: string
}

export function omoDelegateView(metadata: Record<string, unknown> | undefined, status?: string): OmoDelegateView {
  const state = readState(metadata?.state) ?? stateFromToolStatus(status)
  return {
    state,
    ...(typeof metadata?.child_id === "string" && metadata.child_id ? { childID: metadata.child_id } : {}),
    ...(typeof metadata?.agent === "string" && metadata.agent ? { agent: metadata.agent } : {}),
    ...(typeof metadata?.background === "boolean" ? { background: metadata.background } : {}),
    ...(typeof metadata?.verification === "string" && metadata.verification
      ? { verification: metadata.verification }
      : {}),
    ...(readSource(metadata?.source) ? { source: readSource(metadata?.source) } : {}),
    ...(typeof metadata?.fallback_reason === "string" && metadata.fallback_reason
      ? { fallbackReason: metadata.fallback_reason }
      : {}),
    ...(typeof metadata?.downgraded === "string" && metadata.downgraded
      ? { downgraded: metadata.downgraded }
      : {}),
  }
}

function readState(value: unknown): OmoDelegateState | undefined {
  if (value === "running" || value === "completed" || value === "error") return value
  return undefined
}

function stateFromToolStatus(status: string | undefined): OmoDelegateState {
  if (status === "error") return "error"
  if (status === "pending" || status === "running") return "running"
  return "completed"
}

function readSource(value: unknown): OmoDelegateSource | undefined {
  if (value === "semif" || value === "deterministic" || value === "explicit") return value
  return undefined
}
