# SemIf Routing (Stability + Shadow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SemIf safe to observe Session V2 compaction choices: fix the five stability gaps, add an explicit routing contract, ship an offline calibration harness, and shadow `continue_or_compact` without ever blocking `llm.stream`.

**Architecture:** Keep llama.cpp inside `packages/opencode`. Core exposes a no-op `SemifObserve` port. The runner forks `observeCompact` after `compactIfNeeded`. Opencode provides the live layer. `route`/`authoritative` persist in config but execute as shadow with `mode_not_shipped`.

**Tech Stack:** Bun, Effect, existing `SemifService` / `SemifScoring` / Session V2 runner.

## Global Constraints

- Default branch baseline: `origin/dev` @ `750653802`.
- SemIf never blocks a Session drain. Observe is forked; errors swallowed; 750ms timeout.
- Do not implement `route` or `authoritative` steering. They must not change `llm.stream(request)`.
- `packages/core` must not import `packages/opencode`. Observe port stays in core; live layer in opencode.
- Do not edit `.github/workflows/tauri-release.yml` (owned by the Linux desktop plan).
- Default `semif.routing` is `off`.
- After public Protocol/`HttpApi` changes, run `bun run generate` from `packages/client`. Never edit `src/generated` by hand.
- Tests run from `packages/opencode`, `packages/core`, or `packages/app`, never repo root.
- Typecheck with `bun typecheck` from the package directory.
- Conventional commits: `fix(semif): ...` / `feat(semif): ...` / `test(semif): ...` / `chore(sdk): ...`.
- English UI copy in `packages/app/src/i18n/en.ts`; locale parity across `appLocales`.
- Branch: `cursor/semif-routing-plan-6cba`.

**Spec:** `docs/superpowers/specs/2026-09-21-semif-routing-design.md`

## File map

| File | Role |
|---|---|
| `packages/opencode/src/semif/sidecar.ts` | Export health probe for reuse |
| `packages/opencode/src/semif/service.ts` | Health before reuse; pass AbortSignal; dispose warmup |
| `packages/opencode/src/semif/warmup.ts` | Already has `reset()`; dispose must call it |
| `packages/opencode/src/semif/acquire.ts` | Hash existing dest via `verify` |
| `packages/app/src/context/server-session.ts` | Per-session orphan cap |
| `packages/core/src/v1/config/semif.ts` | `routing` literals |
| `packages/opencode/src/semif/config.ts` | Parse routing + effective mode |
| `packages/core/src/session/semif-observe.ts` | Create: no-op port |
| `packages/core/src/session/runner/llm.ts` | Fork observe after compactIfNeeded |
| `packages/opencode/src/semif/observe-live.ts` | Create: live layer |
| `packages/opencode/src/semif/calibration.ts` | Create: metrics |
| `packages/opencode/src/server/routes/instance/httpapi/groups/semif.ts` | Status.routing |
| `packages/client` generated SDK | Regenerated |

---

### Task 1: Health-check before reusing a sidecar handle

**Files:**
- Modify: `packages/opencode/src/semif/sidecar.ts`
- Modify: `packages/opencode/src/semif/service.ts`
- Test: `packages/opencode/test/semif/sidecar.test.ts`

**Interfaces:**
- Consumes: existing `isHealthy(url)` (currently private).
- Produces: `export const health = (url: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>` wrapping the same GET `/health` + 1500ms timeout.

- [ ] **Step 1: Write the failing export test**

Add to `packages/opencode/test/semif/sidecar.test.ts`:

```ts
test("health is true only for HTTP 200 /health", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return new Response("ok", { status: 200 })
      return new Response("no", { status: 404 })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const { health } = await import("../../src/semif/sidecar")
  const ok = await Effect.runPromise(health(url).pipe(Effect.provide(FetchHttpClient.layer)))
  expect(ok).toBe(true)
  server.stop(true)
})
```

Use the same HttpClient layer the file already uses. If `health` is not exported, this fails.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/semif/sidecar.test.ts` from `packages/opencode`

Expected: FAIL — `health` is not exported.

- [ ] **Step 3: Export `health` and use it in `acquireHandle`**

In `sidecar.ts`, export:

```ts
export const health = (url: string): Effect.Effect<boolean, never, HttpClient.HttpClient> => isHealthy(url)
```

In `service.ts` `acquireHandle`, replace:

```ts
const current = yield* Ref.get(state)
if (current.handle) return current.handle
```

with:

```ts
const current = yield* Ref.get(state)
if (current.handle) {
  const alive = yield* provideSidecar(SemifSidecar.health(current.handle.url))
  if (alive) return current.handle
  yield* SemifSidecar.dispose(current.handle)
  SemifScoring.clearCaches()
  yield* Ref.update(state, (value) => ({
    ...value,
    status: "offline" as SemifStatus,
    handle: undefined,
    error: undefined,
  }))
}
```

`snapshot` must call the same health check when `current.handle` is set: if health is false, treat as no handle (do not report `ready`). Keep it inside `dropHandleIfStale` or a new `dropHandleIfDead` invoked from `snapshot` and `acquireHandle`.

- [ ] **Step 4: Re-run tests**

Run: `bun test test/semif/sidecar.test.ts` from `packages/opencode`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/sidecar.ts packages/opencode/src/semif/service.ts packages/opencode/test/semif/sidecar.test.ts
git commit -m "fix(semif): reprobe sidecar health before reuse"
```

---

### Task 2: Cancel decide and warm-up on dispose

**Files:**
- Modify: `packages/opencode/src/semif/scoring.ts` (only if `SemifDecisionRequest` needs `signal`)
- Modify: `packages/opencode/src/semif/service.ts`
- Modify: `packages/opencode/src/semif/warmup.ts` if dispose needs a stop flag beyond `reset`
- Test: `packages/opencode/test/semif/warmup.test.ts`

**Interfaces:**
- Consumes: `SemifWarmup.reset`, `SemifHttp.signal`.
- Produces: `dispose` calls `reset()`; in-flight `run` sleep sees generation change and returns; `decide` forwards `request.signal`.

- [ ] **Step 1: Write the failing warmup dispose test**

Add to `warmup.test.ts`:

```ts
test("reset aborts an in-flight retry sleep", async () => {
  let slept = 0
  const start = Effect.fail("boom")
  const fiber = Effect.runFork(
    run(
      { mode: "auto", download: "auto" },
      start,
      {
        sleep: (ms) =>
          Effect.sync(() => {
            slept += 1
          }).pipe(Effect.zipRight(Effect.sleep(`${ms} millis`))),
        maxAttempts: 8,
      },
    ),
  )
  await Bun.sleep(20)
  reset()
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(slept).toBeGreaterThanOrEqual(0)
})
```

The **required** production change is: `service.dispose` calls `SemifWarmup.reset()` and interrupts the `bootWarmup` fiber stored on the layer.

Add a unit test that documents the contract:

```ts
test("dispose contract calls reset so retryAttempt restarts from 0", () => {
  reset()
  const first = retryDelay(3, 0)
  reset()
  // reset is the public cancel hook; service.dispose must call it.
  expect(typeof reset).toBe("function")
  expect(first).toBeGreaterThan(0)
})
```

Prefer testing `run` with a custom sleep that checks `resetGeneration` — `run` already resets `attempt` when generation changes **after** a failed start. Add:

```ts
test("run stops retrying after reset during sleep", async () => {
  let starts = 0
  const start = Effect.sync(() => {
    starts += 1
    throw new Error("nope")
  }).pipe(Effect.orDie) // will not work — start is Effect.fail

  // Use Effect.fail as existing swallow test does.
})
```

Look at the existing retry test in this file and extend it: call `reset()` from the custom `sleep` on first delay; expect `run` to return without reaching `WARMUP_MAX_ATTEMPTS`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/semif/warmup.test.ts` from `packages/opencode`

Expected: FAIL until `run` observes reset during sleep (today it only checks generation around `start`, not during sleep). Change `run` so that after `sleep`, if `resetGeneration !== startedAt`, `return`.

- [ ] **Step 3: Implement**

In `warmup.ts` after `yield* sleep(...)`:

```ts
if (resetGeneration !== startedAt) return
```

In `service.ts`:

- Keep the warmup fiber: `const warmupFiber = yield* bootWarmup.pipe(..., Effect.forkIn(scope))`
- `dispose`:

```ts
dispose: () =>
  Effect.gen(function* () {
    SemifWarmup.reset()
    yield* Fiber.interrupt(warmupFiber).pipe(Effect.orElseSucceed(() => undefined))
    const current = yield* Ref.get(state)
    if (current.handle) yield* SemifSidecar.dispose(current.handle)
    SemifScoring.clearCaches()
    yield* Ref.set(state, { status: "offline" as SemifStatus })
  }),
```

Import `Fiber` from `effect`.

In `decide`, pass the signal:

```ts
SemifScoring.decide(
  { url: handle.url, signal: request.signal },
  loaded.resolved,
  request,
  SemifManifest.profile(entry),
)
```

Add `signal?: AbortSignal` to `SemifDecisionRequest` in `scoring.ts` if missing.

- [ ] **Step 4: Re-run tests**

Run: `bun test test/semif/warmup.test.ts` from `packages/opencode`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/warmup.ts packages/opencode/src/semif/service.ts packages/opencode/src/semif/scoring.ts packages/opencode/test/semif/warmup.test.ts
git commit -m "fix(semif): cancel warmup and scoring on dispose"
```

---

### Task 3: SHA-256 verify existing model files

**Files:**
- Modify: `packages/opencode/src/semif/acquire.ts`
- Test: `packages/opencode/test/semif/acquire.test.ts`

**Interfaces:**
- Consumes: existing `verify(file, sha256)`.
- Produces: `ensure` hashes dest when size matches; mismatch deletes dest and downloads if `policy === "auto"`.

- [ ] **Step 1: Write the failing test**

Add to `acquire.test.ts`:

```ts
test("ensure rehashes an existing dest and rejects a same-size corrupt file", async () => {
  const dir = await tmpdir()
  const dest = path.join(dir, "LFM2-350M-Q4_K_M.gguf")
  const part = path.join(dir, "model.part")
  const corrupt = new Uint8Array(content.byteLength)
  corrupt.set(content)
  corrupt[0] ^= 0xff
  await Bun.write(dest, corrupt)
  const server = modelServer()
  try {
    const result = await Effect.runPromise(
      ensure({
        dest,
        part,
        sha256: hash,
        expectedBytes: content.byteLength,
        policy: "auto",
        resolveUrl: () => Effect.succeed(server.urls()),
      }).pipe(Effect.provide(layer)),
    )
    expect(result.sha256).toBe(hash)
    expect(result.acquired).toBe(true)
    const disk = createHash("sha256").update(new Uint8Array(await Bun.file(dest).arrayBuffer())).digest("hex")
    expect(disk).toBe(hash)
  } finally {
    server.stop()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("ensure accepts an existing dest only after sha256 matches", async () => {
  const dir = await tmpdir()
  const dest = path.join(dir, "LFM2-350M-Q4_K_M.gguf")
  const part = path.join(dir, "model.part")
  await Bun.write(dest, content)
  try {
    const result = await Effect.runPromise(
      ensure({
        dest,
        part,
        sha256: hash,
        expectedBytes: content.byteLength,
        policy: "never",
        resolveUrl: () => Effect.fail(new AcquireError({ reason: "should not download" })),
      }).pipe(Effect.provide(layer)),
    )
    expect(result.acquired).toBe(false)
    expect(result.sha256).toBe(hash)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
```

Import `AcquireError` if needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/semif/acquire.test.ts` from `packages/opencode`

Expected: FAIL — first test currently returns `acquired: false` with the pinned hash and leaves corrupt bytes on disk.

- [ ] **Step 3: Implement**

Replace the existing-dest short-circuit in `ensure`:

```ts
if (exists) {
  const info = yield* wrap(fs.stat(input.dest))
  if (input.expectedBytes === undefined || Number(info.size) === input.expectedBytes) {
    const hashed = yield* verify(input.dest, input.sha256).pipe(Effect.either)
    if (hashed._tag === "Right") {
      return { path: input.dest, bytes: Number(info.size), sha256: input.sha256, acquired: false }
    }
    yield* wrap(fs.remove(input.dest, { force: true }))
  }
}
```

Keep the `policy !== "auto"` error after that.

- [ ] **Step 4: Re-run tests**

Run: `bun test test/semif/acquire.test.ts` from `packages/opencode`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/acquire.ts packages/opencode/test/semif/acquire.test.ts
git commit -m "fix(semif): sha256-verify existing model files"
```

---

### Task 4: Session-scoped orphan part eviction

**Files:**
- Modify: `packages/app/src/context/server-session.ts`
- Test: add `packages/app/src/context/server-session-orphan.test.ts` extracting the eviction helper if the file is too coupled to Solid.

**Interfaces:**
- Consumes: current `orphanPartLimit = 4096`, `orphanPartTtlMs`.
- Produces: `orphanPartLimitPerSession = 512`; insert evicts that session’s oldest first.

- [ ] **Step 1: Extract a pure helper and write the failing test**

Create `packages/app/src/context/orphan-parts.ts`:

```ts
export const ORPHAN_PART_TTL_MS = 10 * 60 * 1_000
export const ORPHAN_PART_LIMIT = 4_096
export const ORPHAN_PART_LIMIT_PER_SESSION = 512

export type OrphanStore = Map<string, Map<string, number>>

export function evictForInsert(
  store: OrphanStore,
  sessionID: string,
  messageID: string,
  now: number,
): void {
  const session = store.get(sessionID) ?? new Map<string, number>()
  session.set(messageID, now)
  store.set(sessionID, session)
  while (session.size > ORPHAN_PART_LIMIT_PER_SESSION) {
    const oldest = [...session.entries()].sort((a, b) => a[1] - b[1])[0]
    if (!oldest) break
    session.delete(oldest[0])
  }
  let total = 0
  for (const parts of store.values()) total += parts.size
  while (total > ORPHAN_PART_LIMIT) {
    let victim: { sessionID: string; messageID: string; created: number } | undefined
    for (const [id, parts] of store) {
      for (const [message, created] of parts) {
        if (!victim || created < victim.created) victim = { sessionID: id, messageID: message, created }
      }
    }
    if (!victim) break
    store.get(victim.sessionID)?.delete(victim.messageID)
    total -= 1
  }
}
```

Create `packages/app/src/context/orphan-parts.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { evictForInsert, ORPHAN_PART_LIMIT_PER_SESSION } from "./orphan-parts"

describe("orphan part eviction", () => {
  test("evicts the busy session before a quiet one", () => {
    const store = new Map<string, Map<string, number>>()
    evictForInsert(store, "quiet", "q1", 1)
    for (let i = 0; i < ORPHAN_PART_LIMIT_PER_SESSION + 10; i++) {
      evictForInsert(store, "busy", `b${i}`, i + 10)
    }
    expect(store.get("quiet")?.has("q1")).toBe(true)
    expect(store.get("busy")?.size).toBe(ORPHAN_PART_LIMIT_PER_SESSION)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/context/orphan-parts.test.ts` from `packages/app`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement helper and call it from `server-session.ts`**

Replace the inline insert/evict in `trackOrphan` (the block that increments `orphanPartCount`) with `evictForInsert`. Keep TTL GC as-is. Recompute `orphanPartCount` from the store after insert.

- [ ] **Step 4: Re-run tests**

Run: `bun test src/context/orphan-parts.test.ts` from `packages/app`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/context/orphan-parts.ts packages/app/src/context/orphan-parts.test.ts packages/app/src/context/server-session.ts
git commit -m "fix(app): cap orphan parts per session"
```

---

### Task 5: Routing config contract

**Files:**
- Modify: `packages/core/src/v1/config/semif.ts`
- Modify: `packages/opencode/src/semif/config.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/semif.ts`
- Modify: `packages/opencode/src/semif/service.ts` (status.routing)
- Test: `packages/opencode/test/semif/config.test.ts`
- Then: `bun run generate` from `packages/client`

**Interfaces:**
- Consumes: existing `Mode` / `Info` struct.
- Produces:

```ts
export const Routing = Schema.Literals(["off", "assist", "shadow", "route", "authoritative"])
export type Routing = Schema.Schema.Type<typeof Routing>
export type EffectiveRouting = "off" | "assist" | "shadow"

export function effectiveRouting(requested: Routing): {
  effective: EffectiveRouting
  fallbackReason?: "mode_not_shipped"
} {
  if (requested === "route" || requested === "authoritative") {
    return { effective: "shadow", fallbackReason: "mode_not_shipped" }
  }
  return { effective: requested }
}
```

Default requested: `"off"`.

- [ ] **Step 1: Write failing config tests**

Add to `packages/opencode/test/semif/config.test.ts`:

```ts
test("routing defaults to off and demotes route/authoritative to shadow", async () => {
  const { parseSemifOptions, effectiveRouting } = await import("../../src/semif/config")
  expect(parseSemifOptions({}).routing).toBe("off")
  expect(effectiveRouting("shadow")).toEqual({ effective: "shadow" })
  expect(effectiveRouting("route")).toEqual({ effective: "shadow", fallbackReason: "mode_not_shipped" })
  expect(effectiveRouting("authoritative")).toEqual({ effective: "shadow", fallbackReason: "mode_not_shipped" })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/semif/config.test.ts` from `packages/opencode`

Expected: FAIL — `routing` missing.

- [ ] **Step 3: Implement schema + parse + status**

In `packages/core/src/v1/config/semif.ts` add `Routing` and optional/default field on `Info`:

```ts
routing: Routing.pipe(Schema.withDecodingDefault(Effect.succeed("off" as const))).annotate({
  description:
    "How SemIf observes Session V2: off, assist, shadow, route, authoritative. route/authoritative are accepted and executed as shadow until shipped (default: off)",
}),
```

In `parseSemifOptions`, read `options.routing` / `SEMIF_ROUTING`, default `"off"`, reject unknown strings.

Add `routing` to `SemifStatus` and `SemifStatusSchema`:

```ts
routing: Schema.Struct({
  requested: ConfigSemifV1.Routing,
  effective: Schema.Literals(["off", "assist", "shadow"]),
  fallbackReason: Schema.optional(Schema.Literal("mode_not_shipped")),
  last: Schema.optional(
    Schema.Struct({
      task: Schema.String,
      chosen: Schema.String,
      actual: Schema.optional(Schema.String),
      agree: Schema.optional(Schema.Boolean),
      at: Schema.Number,
    }),
  ),
}),
```

- [ ] **Step 4: Generate client**

From `packages/client`: `bun run generate`

- [ ] **Step 5: Typecheck + tests**

```bash
bun test test/semif/config.test.ts   # packages/opencode
bun typecheck                        # packages/opencode
bun typecheck                        # packages/core
bun typecheck                        # packages/client
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/v1/config/semif.ts packages/opencode/src/semif/config.ts packages/opencode/src/semif/service.ts packages/opencode/src/server/routes/instance/httpapi/groups/semif.ts packages/opencode/test/semif/config.test.ts packages/client
git commit -m "feat(semif): add routing mode contract"
```

---

### Task 6: Calibration harness

**Files:**
- Create: `packages/opencode/src/semif/calibration.ts`
- Create: `packages/opencode/test/semif/calibration.fixture.json`
- Test: `packages/opencode/test/semif/calibration.test.ts`

**Interfaces:**
- Consumes: arrays of `{ expectedIndex: number, probabilities: number[] }`.
- Produces: `{ accuracy, margin, brier, ece, coverage: Record<string, { covered: number, accuracy: number }> }`.

- [ ] **Step 1: Write the failing test with hand-computed fixture**

`calibration.fixture.json`:

```json
{
  "cases": [
    { "task": "continue_or_compact", "expectedIndex": 0, "probabilities": [0.9, 0.1] },
    { "task": "continue_or_compact", "expectedIndex": 0, "probabilities": [0.6, 0.4] },
    { "task": "continue_or_compact", "expectedIndex": 1, "probabilities": [0.2, 0.8] },
    { "task": "continue_or_compact", "expectedIndex": 1, "probabilities": [0.55, 0.45] }
  ]
}
```

Case 4 is a miss (argmax is 0, expected 1).

`calibration.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { summarize } from "../../src/semif/calibration"
import fixture from "./calibration.fixture.json"

test("summarize matches hand metrics on the fixture", () => {
  const result = summarize(fixture.cases)
  expect(result.accuracy).toBeCloseTo(0.75, 5)
  expect(result.brier).toBeCloseTo(
    ((0.9 - 1) ** 2 + (0.1 - 0) ** 2 +
      (0.6 - 1) ** 2 + (0.4 - 0) ** 2 +
      (0.2 - 0) ** 2 + (0.8 - 1) ** 2 +
      (0.55 - 0) ** 2 + (0.45 - 1) ** 2) / 4,
    5,
  )
  expect(result.coverage["0.8"]?.covered).toBeCloseTo(0.5, 5)
  expect(result.coverage["0.8"]?.accuracy).toBeCloseTo(1, 5)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/semif/calibration.test.ts` from `packages/opencode`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `summarize`**

```ts
export type Case = { task?: string; expectedIndex: number; probabilities: number[] }

export function summarize(cases: readonly Case[]) {
  if (cases.length === 0) {
    return { accuracy: 0, margin: 0, brier: 0, ece: 0, coverage: {} as Record<string, { covered: number; accuracy: number }> }
  }
  let correct = 0
  let margin = 0
  let brier = 0
  const bins = Array.from({ length: 10 }, () => ({ conf: 0, acc: 0, n: 0 }))
  for (const item of cases) {
    const best = item.probabilities.reduce((b, v, i) => (v > item.probabilities[b]! ? i : b), 0)
    if (best === item.expectedIndex) correct += 1
    const sorted = [...item.probabilities].sort((a, b) => b - a)
    margin += (sorted[0] ?? 0) - (sorted[1] ?? 0)
    brier += item.probabilities.reduce((sum, p, i) => sum + (p - (i === item.expectedIndex ? 1 : 0)) ** 2, 0)
    const conf = item.probabilities[best] ?? 0
    const bin = Math.min(9, Math.floor(conf * 10))
    bins[bin]!.n += 1
    bins[bin]!.conf += conf
    bins[bin]!.acc += best === item.expectedIndex ? 1 : 0
  }
  const n = cases.length
  const ece =
    bins.reduce((sum, bin) => {
      if (bin.n === 0) return sum
      return sum + (bin.n / n) * Math.abs(bin.acc / bin.n - bin.conf / bin.n)
    }, 0)
  const coverage: Record<string, { covered: number; accuracy: number }> = {}
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const subset = cases.filter((item) => Math.max(...item.probabilities) >= t)
    const hits = subset.filter((item) => {
      const best = item.probabilities.reduce((b, v, i) => (v > item.probabilities[b]! ? i : b), 0)
      return best === item.expectedIndex
    }).length
    coverage[String(t)] = { covered: subset.length / n, accuracy: subset.length === 0 ? 0 : hits / subset.length }
  }
  return { accuracy: correct / n, margin: margin / n, brier: brier / n, ece, coverage }
}
```

Do not call llama.cpp. Do not treat argmax as ground truth.

- [ ] **Step 4: Re-run test**

Run: `bun test test/semif/calibration.test.ts` from `packages/opencode`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/semif/calibration.ts packages/opencode/test/semif/calibration.test.ts packages/opencode/test/semif/calibration.fixture.json
git commit -m "test(semif): add offline calibration harness"
```

---

### Task 7: Core observe port + shadow on compact

**Files:**
- Create: `packages/core/src/session/semif-observe.ts`
- Modify: `packages/core/src/session/runner/llm.ts`
- Create: `packages/opencode/src/semif/observe-live.ts`
- Wire the live layer in the opencode app-node that already provides `SemifService`
- Test: `packages/core/test/semif-observe.test.ts` and a runner test that compact still proceeds when observe fails

**Interfaces:**
- Consumes: `compactIfNeeded` boolean; `SessionSchema.ID`.
- Produces: `SemifObserve.Service.observeCompact` forked; default no-op layer.

- [ ] **Step 1: Write failing port tests in core**

`packages/core/src/session/semif-observe.ts` (create after RED by adding the test first that imports it):

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SemifObserve } from "../src/session/semif-observe"

it.effect("noop observe succeeds without changing the value", () =>
  Effect.gen(function* () {
    const observe = yield* SemifObserve.Service
    yield* observe.observeCompact({
      sessionID: "ses_test" as never,
      actual: "continue",
      evidence: "tokens=1",
      tokensBefore: 100,
      tokensAfterIfCompact: 40,
    })
  }).pipe(Effect.provide(SemifObserve.noop)),
)
```

Use the same test runner as `packages/core/test/session-runner.test.ts` (`it.effect`). If SessionSchema.ID.make exists, use it.

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/core` the existing test command for that package (see `package.json` scripts; typically `bun test test/semif-observe.test.ts` or `vitest`). Match neighboring tests.

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the port**

```ts
export * as SemifObserve from "./semif-observe"

import { Context, Effect, Layer } from "effect"
import { SessionSchema } from "./schema"

export type CompactChoice = "continue" | "compact"

export interface ObserveCompactInput {
  readonly sessionID: SessionSchema.ID
  readonly actual: CompactChoice
  readonly evidence: string
  readonly tokensBefore: number
  readonly tokensAfterIfCompact: number
}

export interface Interface {
  readonly observeCompact: (input: ObserveCompactInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SemifObserve") {}

export const noop = Layer.succeed(Service, {
  observeCompact: () => Effect.void,
} satisfies Interface)
```

In `runner/llm.ts`, after:

```ts
if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
  return yield* Effect.die(continueAfterCompaction(currentStep))
```

fork observe **for both branches** (compact vs continue). The compact branch must observe `actual: "compact"` before the die. The continue path observes `actual: "continue"` then proceeds to `llm.stream`.

```ts
const observe = yield* SemifObserve.Service
const tokensBefore = estimateFromRequest(request) // reuse SessionCompaction's Token estimator if exported; otherwise pass 0
yield* observe
  .observeCompact({
    sessionID: session.id,
    actual: compacted ? "compact" : "continue",
    evidence: `session=${session.id}`,
    tokensBefore,
    tokensAfterIfCompact: Math.floor(tokensBefore * 0.4),
  })
  .pipe(Effect.forkDaemon, Effect.orElseSucceed(() => undefined))
```

If `Token.estimate` is not exported from compaction, pass `tokensBefore: 0` rather than duplicating the estimator. Prefer exporting a tiny `SessionCompaction.estimateRequest(request)` if it is one line.

Default-provide `SemifObserve.noop` in the runner’s test layers and the core app-node so existing tests keep working.

- [ ] **Step 4: Live layer in opencode**

`observe-live.ts`:

```ts
export const layer = Layer.effect(
  SemifObserve.Service,
  Effect.gen(function* () {
    const semif = yield* SemifService.Service
    return {
      observeCompact: (input) =>
        Effect.gen(function* () {
          const snap = yield* semif.status()
          if (snap.routing.effective === "off") return
          const decision = yield* semif.decide({
            id: `shadow:${input.sessionID}:continue_or_compact`,
            state: input.evidence,
            question: "Should the session compact context before the next provider turn, or continue?",
            options: [
              { id: "continue", description: "Continue without compacting." },
              { id: "compact", description: "Compact session context first." },
            ],
            signal: AbortSignal.timeout(750),
          }).pipe(Effect.timeout("750 millis"), Effect.orElseSucceed(() => undefined))
          if (!decision) return
          const agree = decision.chosen === input.actual
          yield* Effect.logInfo("semif.shadow", {
            task: "continue_or_compact",
            actual: input.actual,
            chosen: decision.chosen,
            agree,
            latencyMs: Math.round(decision.total_seconds * 1000),
            hypotheticalTokensSaved: input.actual === "continue" && decision.chosen === "compact"
              ? Math.max(0, input.tokensBefore - input.tokensAfterIfCompact)
              : 0,
          })
        }).pipe(Effect.orElseSucceed(() => undefined), Effect.forkDaemon, Effect.asVoid)
    }
  }),
)
```

Wire `layer` next to `SemifService.node` in the server app graph. If the graph is hard to find, search `SemifService.node` and provide both.

**Do not** skip `llm.stream`. **Do not** call observe when `effective === "off"` (live layer still returns immediately).

- [ ] **Step 5: Tests + typecheck**

From `packages/core` and `packages/opencode`: existing session-runner tests must still pass. Add one test that a throwing observe layer does not prevent `llm.stream`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session/semif-observe.ts packages/core/src/session/runner/llm.ts packages/opencode/src/semif/observe-live.ts packages/core/test/semif-observe.test.ts
git commit -m "feat(semif): shadow continue_or_compact without blocking the runner"
```

---

### Task 8: Docs

**Files:**
- Modify: `specs/semif-plugin.md` section 9 pendências + new subsection “Routing”
- Modify: `packages/app` i18n only if the status popover shows `routing.last` (optional one line)

**Interfaces:**
- Consumes: mode table from the spec.
- Produces: honest docs that scores stay uncalibrated and route/authoritative do not steer.

- [ ] **Step 1: Update `specs/semif-plugin.md`**

Add:

```md
### Routing (2026-09-21)

`semif.routing`: `off` (default) | `assist` | `shadow` | `route` | `authoritative`.
Only off/assist/shadow execute. route/authoritative are stored and run as shadow
(`mode_not_shipped`). SemIf never blocks Session V2. Calibration metrics live in
`src/semif/calibration.ts` and do not rewrite sidecar probabilities into confidence.
```

Replace stale pendência “CUDA/Vulkan opcionais” if Vulkan already shipped; keep macOS smoke and progress-event notes.

- [ ] **Step 2: Commit**

```bash
git add specs/semif-plugin.md
git commit -m "docs(semif): document routing contract and shadow scope"
```

---

## Self-review

- Five stability gaps each have a task.
- Calibration, allowlist (`continue_or_compact` only), efficiency hypothetical log, and the five-mode contract are covered.
- No `llm.stream` mutation. No `tauri-release.yml`. No Linux packaging.
- Core does not import opencode.
