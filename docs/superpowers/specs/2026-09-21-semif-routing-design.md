# SemIf routing contract (stability, calibration, shadow)

**Status:** approved for implementation planning  
**Baseline:** `origin/dev` @ `750653802` (includes SemIf Vulkan PR #16)  
**Non-goals:** `route` / `authoritative` steering, changing `llm.stream` request contents, Linux AppImage packaging, editing `.github/workflows/tauri-release.yml`

## Problem

SemIf is a local letter-slot oracle. Its probabilities are **uncalibrated softmax among the listed options** (`probability_status` already says so). Treating 0.69 as “69% confident” is false.

The product brief asked for SemIf as a router in front of “OMO Slim”. There is **no OMO module** in this repo. The coding agent is Session V2: `SessionV2.prompt` admits a durable inbox row, `SessionRunner` drains, one `llm.stream(request)` per provider turn. That runner **is** OMO Slim for this work.

Five stability gaps are real in current code:

| Gap | Where | What happens |
|---|---|---|
| Dead sidecar | `acquireHandle` in `packages/opencode/src/semif/service.ts` | A cached `handle` is reused with no `/health` probe. `snapshot` reports `ready`. `decide` posts to a dead port. |
| Cancel | `SemifService.decide` → `SemifScoring.decide` | Scoring already accepts `AbortSignal`; the service never passes one. `SemifWarmup.run` sleeps between retries; `dispose` does not call `SemifWarmup.reset()` or interrupt that fiber. |
| SHA-256 of existing models | `SemifAcquire.ensure` | If `dest` exists and size matches, it returns the **pinned** digest without hashing the file. `verify()` exists and is unused on that path. A truncated-then-padded or swapped file of the same size loads. |
| Orphan parts across sessions | `packages/app/src/context/server-session.ts` | `orphanPartLimit = 4096` is **global**. Eviction walks every session and drops the globally oldest part, so a busy session can wipe another session’s pending parts. |
| dispose / timers | warmup fiber + `orphanGcTimer` | Sidecar kill on dispose is correct for spawned handles. Warmup retries keep running. UI `orphanGcTimer` is fine if session teardown clears it (it does when count hits 0); the SemIf gap is the warmup fiber. |

## Law

**SemIf never blocks a Session drain.** A SemIf failure, timeout, miss, or “not ready” is a no-op for the runner. The only way SemIf may change provider work is an explicit later mode (`route` / `authoritative`) that this plan does **not** implement.

## Routing modes

Config key: `semif.routing` (string). Default **`off`**.

| Mode | Behavior this plan ships |
|---|---|
| `off` | No Session-runner calls. Tools `semif_decide` / HTTP still work. |
| `assist` | Same observe path as shadow, plus last suggestion on `GET /semif/status` (`routing.last`). Session still ignores it. |
| `shadow` | Forked observe only. Logs agree/disagree vs the runner’s actual choice. |
| `route` | **Not implemented.** Config accepted; `effectiveRouting = shadow` with `routingFallbackReason: "mode_not_shipped"`. Never steers. |
| `authoritative` | Same as `route`. Never steers. |

Do not add a user-facing backend picker. Do not require a wizard. Autonomous NextCode means SemIf still warms up on `mode: auto`; routing stays **off** until someone sets `semif.routing`.

## Dependency direction

`packages/core` must not import `packages/opencode`. SessionRunner lives in core. SemIf lives in opencode.

Introduce a core port:

```ts
// packages/core/src/session/semif-observe.ts
export type CompactChoice = "continue" | "compact"
export interface Suggestion {
  readonly task: "continue_or_compact"
  readonly chosen: CompactChoice
  readonly probabilities: readonly number[]
  readonly latencyMs: number
}
export interface Interface {
  readonly observeCompact: (input: {
    readonly sessionID: SessionSchema.ID
    readonly actual: CompactChoice
    readonly evidence: string
  }) => Effect.Effect<void>
}
```

Default layer: `Effect.void` (no-op). Opencode provides the live layer that:

1. Returns immediately (forks the work).
2. Calls `SemifService.decide` with a 750ms timeout and an `AbortSignal`.
3. Swallows every error.
4. Logs `semif.shadow` with `{ task, actual, chosen, agree, latencyMs, hypothetical }`.
5. Stores `last` for assist/status.

SessionRunner, immediately after `compactIfNeeded` returns (so `actual` is known), calls `observeCompact`. It does **not** wait. It does **not** change `llm.stream(request)`.

“OMO Slim decided” = the boolean `compactIfNeeded` already computed (auto-compaction vs continue). SemIf’s letter options are `continue` and `compact`. Shadow compares those two.

## Allowlist

Only task id `continue_or_compact` is live. Anything else is ignored in the live layer. Calibration fixtures may include other task ids; the runner will not call them.

## Calibration harness

New module `packages/opencode/src/semif/calibration.ts` (pure). Input: labeled cases `{ task, expected, probabilities }` (probabilities already softmaxed among options — do not call llama.cpp in unit tests).

Metrics:

- accuracy
- mean margin (`p_chosen - p_second`)
- Brier score vs one-hot expected
- ECE with 10 equal-width bins
- coverage vs error: for thresholds `t` in `{0.5,0.6,0.7,0.8,0.9}`, accuracy among cases with `max(p) >= t`, and fraction covered
- per-task breakdown when `task` is present

CLI/test entry: `bun test test/semif/calibration.test.ts` from `packages/opencode`. Fixture JSON under `packages/opencode/test/semif/calibration.fixture.json`.

Uncalibrated scores must keep `probability_status` unchanged. The harness does not rewrite sidecar output into “confidence”.

## Efficiency inequality

Gate before any future `route` ship (not implemented now):

```
tokens_saved > semif_calls * tokens_per_call + error_tokens + latency_penalty
```

Shadow logs a **hypothetical** line: if SemIf’s `compact` had been honored, estimate tokens avoided as `request` token estimate minus post-compact estimate (use the same `Token` estimator `SessionCompaction` uses, passed in the observe payload as two numbers from the runner: `tokensBefore`, `tokensAfterIfCompact`). SemIf cost is `input_tokens` from the decision plus `forward_seconds`. Do not skip a provider turn.

## Stability fixes (must precede shadow)

1. **Dead sidecar:** before reusing `current.handle`, `GET {url}/health` with the existing 1500ms timeout. On failure, `SemifSidecar.dispose` + clear handle + spawn again. `snapshot` must not say `ready` if health failed.
2. **Cancel:** `SemifDecisionRequest` already can grow `signal?: AbortSignal`. Service `decide` passes it. `dispose` calls `SemifWarmup.reset()` and interrupts the boot warmup fiber (`Fiber.interrupt` on the `forkIn` handle).
3. **SHA-256:** `ensure` hashes an existing dest via `verify` when size matches. On mismatch, delete dest and fall through to download under `policy === "auto"`; otherwise `AcquireError`.
4. **Orphan parts:** add `orphanPartLimitPerSession = 512`. Global 4096 remains. When inserting, if that session exceeds 512, evict that session’s oldest first. Global eviction only if total still exceeds 4096 after per-session trim.
5. **dispose:** after killing the spawned sidecar, `clearCaches()`, `SemifWarmup.reset()`, interrupt warmup fiber, status `offline`.

## Sequence (this plan)

1. Stability (five gaps).
2. Config + status contract (five mode literals; only off/assist/shadow execute).
3. Calibration harness (offline).
4. Shadow observe on `continue_or_compact`.
5. Allowlist (single task) + hypothetical efficiency log.

Stop. Do not implement `route` / `authoritative` steering. Do not run that work in parallel with the Linux AppImage plan (different branch, no shared files except none — **do not touch `tauri-release.yml`**).

## HTTP / UI

`GET /semif/status` gains optional:

```ts
routing: {
  requested: "off" | "assist" | "shadow" | "route" | "authoritative"
  effective: "off" | "assist" | "shadow"
  fallbackReason?: "mode_not_shipped"
  last?: { task: string; chosen: string; actual?: string; agree?: boolean; at: number }
}
```

After `HttpApi` changes, `bun run generate` from `packages/client`. Do not edit `src/generated` by hand.

UI: no new picker required. Optional one-line in the existing SemIf status popover when `last` is present (assist/shadow). English keys in `packages/app/src/i18n/en.ts` with locale parity.

## Testing

- Sidecar health: ensure reuses handle only after health true; dead handle respawns (mock HTTP).
- Warmup: `dispose` increments reset generation so in-flight sleep aborts (existing `reset()` test pattern).
- Acquire: existing dest with wrong hash is not trusted.
- Orphan GC: two sessions, fill A, B’s parts survive.
- Calibration fixture metrics match hand-computed values.
- Observe: runner still streams when the live layer fails; no extra `llm.stream` call.
- Config: `routing: "route"` → effective shadow + `mode_not_shipped`.

## Out of scope

- Steering the provider model, tools, or compact decision
- A second llama.cpp model
- Changing mixed-GPU / Vulkan auto policy
- Linux desktop packaging
- Bundling calibration into CI GPU runners
