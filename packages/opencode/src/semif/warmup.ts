// Boot and first-use warm-up policy for the process-global SemIf service.
//
// The native service only prepares the model when a caller asks (HTTP route or
// tool). To satisfy "install NextCode and SemIf is ready with no user step", the
// service kicks its own preparation after boot when the config opts in. The
// policy is deliberately narrow:
//
//   mode=auto + download=auto -> prepare in the background right after boot
//   mode=lazy                 -> prepare on the first decision
//   mode=off                  -> never prepare
//   download=manual | never   -> never download implicitly
//
// `run` never propagates failures: the service records its own `failed` status
// (and an `unsupported` platform is reported as-is), so a manual retry via
// `POST /semif/start` stays possible.

import { Effect, Exit } from "effect"
import type { Status } from "./service"

export type Policy = Pick<Status, "mode" | "download">

export const WARMUP_RETRY_MIN_MS = 5_000
export const WARMUP_RETRY_MAX_MS = 5 * 60_000
export const WARMUP_MAX_ATTEMPTS = 8
const WARMUP_RETRY_JITTER = 0.2
const WARMUP_WARNING_DEDUP_MS = 60_000

let resetGeneration = 0

export const reset = () => {
  resetGeneration += 1
}

export const retryDelay = (attempt: number, random = Math.random()) => {
  const base = Math.min(WARMUP_RETRY_MAX_MS, WARMUP_RETRY_MIN_MS * 2 ** attempt)
  return Math.min(WARMUP_RETRY_MAX_MS, Math.round(base * (1 + Math.max(0, Math.min(1, random)) * WARMUP_RETRY_JITTER)))
}

export const failureMessageKey = (message: string) =>
  message
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\b\d{6,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()

export type RunOptions = {
  readonly sleep?: (milliseconds: number) => Effect.Effect<void>
  readonly random?: () => number
  readonly maxAttempts?: number
}

export const shouldWarmup = (policy: Policy): boolean => policy.mode === "auto" && policy.download === "auto"

// A first decision may kick preparation only when the mode allows it and the
// current state is not already in flight. A missing model is fetched only under
// `download: auto`; `manual` and `never` must not download implicitly.
export const shouldPrepare = (status: Pick<Status, "status" | "mode" | "download">): boolean => {
  if (status.mode === "off") return false
  switch (status.status) {
    case "ready":
    case "disabled":
    case "unsupported":
    case "downloading":
    case "verifying":
    case "starting":
      return false
    case "not_downloaded":
      return status.download === "auto"
    case "failed":
    case "offline":
      return true
  }
}

// Starts `start` in the background without ever failing the caller. Failures are
// logged; the service already records the matching `failed` status.
export const run = Effect.fn("SemifWarmup.run")(function* (
  policy: Policy,
  start: Effect.Effect<void, unknown>,
  options: RunOptions = {},
) {
  if (!shouldWarmup(policy)) return
  const sleep = options.sleep ?? ((milliseconds: number) => Effect.sleep(`${milliseconds} millis`))
  const maxAttempts = options.maxAttempts ?? WARMUP_MAX_ATTEMPTS
  const warnings = new Map<string, number>()
  let attempt = 0

  while (attempt < maxAttempts) {
    const startedAt = resetGeneration
    const exit = yield* Effect.exit(start)
    if (!Exit.isFailure(exit)) return

    const message = String(exit.cause)
    const key = failureMessageKey(message)
    const now = Date.now()
    const previous = warnings.get(key)
    if (previous === undefined || now - previous >= WARMUP_WARNING_DEDUP_MS) {
      warnings.set(key, now)
      yield* Effect.logWarning("semif warm-up failed", { cause: exit.cause })
    }
    for (const [warning, timestamp] of warnings) {
      if (now - timestamp >= WARMUP_WARNING_DEDUP_MS) warnings.delete(warning)
    }

    const retryAttempt = resetGeneration === startedAt ? attempt : 0
    if (retryAttempt >= maxAttempts - 1) return
    yield* sleep(retryDelay(retryAttempt, options.random?.()))
    if (resetGeneration !== startedAt) return
    attempt = resetGeneration === startedAt ? retryAttempt + 1 : 0
  }
})

export * as SemifWarmup from "./warmup"
