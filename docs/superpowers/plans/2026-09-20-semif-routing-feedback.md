# SemIf Routing Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show immediate, truthful SemIf routing and OMO delegation phases in the NextCode session timeline.

**Architecture:** Add a typed, live-only session event and publish it through a small OMO activity tracker shared by the router and delegate tool. Project the event into ephemeral session state with sequence watermarks, then feed the active activity into the existing thinking row and shared thinking-status presentation.

**Tech Stack:** TypeScript, Effect Schema and services, EventV2, SolidJS stores/components, Bun tests, Playwright SSE fixtures.

**Spec:** `docs/superpowers/specs/2026-09-20-semif-routing-feedback-design.md`

## Global Constraints

- The event is non-durable and must not be persisted or replayed.
- Do not extend generic `SessionStatus`; use the OMO-specific event.
- Emit `analyzing` only immediately before a real `semif.decide(...)` call.
- Use exactly these phases: `analyzing`, `selected`, `delegating`, and `cleared`.
- Correlate with `sessionID`, `assistantMessageID`, and `toolCallID`; reject stale sequences.
- Never send prompts, evidence, option descriptions, scores, model paths, or raw exception text to the UI.
- Do not add percentages, completion estimates, or artificial phase delays.
- Portuguese and English copy must match the approved compact format.
- Preserve Schema -> Core/Protocol -> Server runtime dependency direction; client code may not depend on Core or Server.
- Regenerate public clients; never edit generated sources manually.
- Run tests and `bun typecheck` from package directories, never the repository root.

## Review Focus

- A delayed `selected` event after `cleared` must not recreate visible activity; Task 4 tests the retained watermark.
- A partial explicit override may still call SemIf; Task 3 tests genuine `analyzing` followed by `source: "explicit"`.
- Two concurrent sessions and two tool calls in one session must remain isolated; Tasks 4 and 6 test both dimensions.
- Event publication failure must not fail or cancel routing/delegation; Tasks 2 and 3 inject a failing publisher.
- A settled assistant message, idle session, reconnect, or eviction must leave no stale indicator; Task 4 tests every cleanup boundary.

---

## File Structure

- `packages/schema/src/omo.ts`: shared bounded OMO identifiers used by Schema and Core.
- `packages/schema/src/omo-routing-event.ts`: live event schema and public activity types.
- `packages/schema/src/event-manifest.ts`: registers the live event for both server event surfaces.
- `packages/opencode/src/omo/routing-activity.ts`: creates one safe, sequenced tracker per tool call.
- `packages/opencode/src/omo/router.ts`: reports the exact boundary where SemIf is invoked.
- `packages/opencode/src/omo/delegate-tool.ts`: owns tracker creation, selection/delegation transitions, and final cleanup.
- `packages/app/src/context/server-session.ts`: projects live routing activity and lifecycle cleanup.
- `packages/app/src/pages/session/timeline/omo-routing-status.ts`: pure phase-to-label mapping.
- `packages/session-ui/src/components/thinking-status.tsx`: reusable label and elapsed-time presentation.
- `packages/app/src/pages/session/timeline/rows.ts`: associates current routing activity with the thinking row.
- `packages/app/src/pages/session/timeline/message-timeline.tsx`: supplies activity and renders the shared status.
- `packages/app/e2e/user-story/omo-routing-feedback.spec.ts`: controlled SSE user-story coverage.

### Task 1: Define the public live routing contract

**Files:**
- Create: `packages/schema/src/omo.ts`
- Create: `packages/schema/src/omo-routing-event.ts`
- Create: `packages/schema/test/omo-routing-event.test.ts`
- Modify: `packages/schema/src/event-manifest.ts:1-83`
- Modify: `packages/core/src/config/omo.ts:1-35`
- Modify: `packages/core/src/omo.ts:1-43`
- Regenerate: `packages/client/src/generated/**`
- Regenerate: `packages/client/src/generated-effect/**`
- Regenerate: `packages/sdk/js/src/gen/**`
- Regenerate: `packages/sdk/js/src/v2/gen/**`

**Interfaces:**
- Consumes: `Event.define`, `SessionID`, `SessionMessage.ID`, `NonNegativeInt`.
- Produces: `Omo.AgentID`, `Omo.Verification`, `Omo.RoutingSource`, `OmoRoutingEvent.Updated`, and `OmoRoutingEvent.OmoRoutingActivity`.

- [ ] **Step 1: Write the failing schema tests**

Create `packages/schema/test/omo-routing-event.test.ts` with tests that decode every phase, prove the event is non-durable, reject an unknown agent/source/phase, and reject sensitive excess fields:

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OmoRoutingEvent } from "../src/omo-routing-event"

const base = {
  sessionID: "ses_feedback",
  assistantMessageID: "msg_feedback",
  toolCallID: "call_feedback",
  sequence: 0,
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

describe("OMO routing activity event", () => {
  test("is live-only and accepts all bounded phases", () => {
    expect(OmoRoutingEvent.Updated.durable).toBeUndefined()
    const decode = Schema.decodeUnknownSync(OmoRoutingEvent.Updated.data)
    expect(decode({ ...base, state: { phase: "analyzing" } }).state.phase).toBe("analyzing")
    expect(
      decode({
        ...base,
        sequence: 1,
        state: {
          phase: "selected",
          agent: "fixer",
          source: "semif",
          background: false,
          verification: "tests",
          durationMs: 42,
        },
      }).state.phase,
    ).toBe("selected")
    expect(
      decode({
        ...base,
        sequence: 2,
        state: { phase: "delegating", agent: "fixer", source: "semif", background: false },
      }).state.phase,
    ).toBe("delegating")
    expect(decode({ ...base, sequence: 3, state: { phase: "cleared" } }).state.phase).toBe("cleared")
  })

  test("rejects unbounded routing data", () => {
    const decode = Schema.decodeUnknownSync(OmoRoutingEvent.Updated.data, { onExcessProperty: "error" })
    expect(() => decode({ ...base, state: { phase: "analyzing" }, prompt: "secret" })).toThrow()
    expect(() =>
      decode({
        ...base,
        state: {
          phase: "selected",
          agent: "unknown",
          source: "semif",
          background: false,
          verification: "tests",
          durationMs: 10,
        },
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run from `packages/schema`:

```powershell
bun test test/omo-routing-event.test.ts
```

Expected: FAIL because `src/omo-routing-event.ts` does not exist.

- [ ] **Step 3: Add shared OMO primitives and the event schema**

Create `packages/schema/src/omo.ts` with the stable literals currently defined in Core:

```ts
export * as Omo from "./omo"

import { Schema } from "effect"

export const AgentIDs = ["orchestrator", "explore", "librarian", "oracle", "designer", "fixer", "observer"] as const
export const AgentID = Schema.Literals(AgentIDs).annotate({ identifier: "OmoAgentID" })
export type AgentID = typeof AgentID.Type

export const Verification = Schema.Literals(["none", "tests", "oracle", "observer"]).annotate({
  identifier: "OmoVerification",
})
export type Verification = typeof Verification.Type

export const RoutingSource = Schema.Literals(["semif", "deterministic", "explicit"]).annotate({
  identifier: "OmoRoutingSource",
})
export type RoutingSource = typeof RoutingSource.Type
```

Create `packages/schema/src/omo-routing-event.ts`:

```ts
export * as OmoRoutingEvent from "./omo-routing-event"

import { Schema } from "effect"
import { Event } from "./event"
import { Omo } from "./omo"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { NonNegativeInt } from "./schema"

export const FallbackCode = Schema.Literals([
  "unavailable",
  "timeout",
  "invalid_response",
  "ineligible_response",
  "incomplete_response",
  "policy",
  "single_strategy",
])
export type FallbackCode = typeof FallbackCode.Type

export const State = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("analyzing") }),
  Schema.Struct({
    phase: Schema.Literal("selected"),
    agent: Omo.AgentID,
    source: Omo.RoutingSource,
    background: Schema.Boolean,
    verification: Omo.Verification,
    durationMs: NonNegativeInt,
    fallback: FallbackCode.pipe(Schema.optional),
  }),
  Schema.Struct({
    phase: Schema.Literal("delegating"),
    agent: Omo.AgentID,
    source: Omo.RoutingSource,
    background: Schema.Boolean,
  }),
  Schema.Struct({ phase: Schema.Literal("cleared") }),
])

export const Updated = Event.define({
  type: "session.omo.routing",
  schema: {
    sessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
    toolCallID: Schema.String,
    sequence: NonNegativeInt,
    startedAt: NonNegativeInt,
    updatedAt: NonNegativeInt,
    state: State,
  },
})
export type OmoRoutingActivity = typeof Updated.data.Type
export const Definitions = Event.inventory(Updated)
```

Register `OmoRoutingEvent.Definitions` in `featureDefinitions` in `packages/schema/src/event-manifest.ts`. Refactor `packages/core/src/config/omo.ts` to re-export `AgentIDs`, `AgentID`, and `Verification` from `Omo`, and refactor `packages/core/src/omo.ts` to re-export `RoutingSource` from `Omo`. This removes duplicate literal lists while preserving every existing Core import.

- [ ] **Step 4: Run focused tests and typechecks**

Run:

```powershell
Set-Location packages/schema
bun test test/omo-routing-event.test.ts test/event-manifest.test.ts
bun typecheck
Set-Location ../core
bun test test/omo.test.ts
bun typecheck
```

Expected: all commands PASS; existing `ConfigOmo.AgentID` and `RoutingSource` consumers compile unchanged.

- [ ] **Step 5: Regenerate both public clients**

Run:

```powershell
Set-Location packages/client
bun run generate
bun typecheck
Set-Location ../sdk/js
bun run script/build.ts
bun typecheck
```

Expected: generated event unions include `session.omo.routing`; both package typechecks PASS. Inspect generated changes to confirm they contain only generator output.

- [ ] **Step 6: Commit the contract**

```powershell
git add packages/schema packages/core/src/config/omo.ts packages/core/src/omo.ts packages/client/src/generated packages/client/src/generated-effect packages/sdk/js/src/gen packages/sdk/js/src/v2/gen
git commit -m "feat(omo): add routing activity event"
```

### Task 2: Add the safe OMO activity tracker

**Files:**
- Create: `packages/opencode/src/omo/routing-activity.ts`
- Create: `packages/opencode/test/omo/routing-activity.test.ts`

**Interfaces:**
- Consumes: `OmoRoutingEvent.Updated`, `EventV2Bridge.Service`, and `OmoRoutingRecommendation`.
- Produces: `OmoRoutingActivity.Identity`, `OmoRoutingActivity.Tracker`, and `OmoRoutingActivity.Service.start(identity)`.

- [ ] **Step 1: Write failing tracker tests**

Create tests around a fake activity publisher. `makeTracker` accepts `Publish` and returns `Tracker`. Pin exact sequence values, stable timestamps, fallback sanitization, and swallowed publication failure:

```ts
const published: OmoRoutingEvent.OmoRoutingActivity[] = []
const publish: OmoRoutingActivity.Publish = (activity) =>
  Effect.sync(() => {
    published.push(activity)
  })
const tracker = OmoRoutingActivity.makeTracker(publish, {
  sessionID,
  assistantMessageID,
  toolCallID: "call_feedback",
  startedAt: 100,
})

yield* tracker.analyzing()
yield* tracker.selected({
  agent: "fixer",
  background: false,
  verification: "tests",
  source: "deterministic",
  alternatives: [],
  fallbackReason: "semif decision timed out after 750ms",
})
yield* tracker.delegating({ agent: "fixer", background: false, source: "deterministic" })
yield* tracker.clear()

expect(published.map((event) => event.sequence)).toEqual([0, 1, 2, 3])
expect(published[1]?.state).toMatchObject({ phase: "selected", fallback: "timeout" })
expect(JSON.stringify(published)).not.toContain("timed out after 750ms")
```

Add a second fake whose `publish` dies and assert every tracker method still succeeds.

- [ ] **Step 2: Run the test and verify it fails**

Run from `packages/opencode`:

```powershell
bun test test/omo/routing-activity.test.ts
```

Expected: FAIL because the tracker module does not exist.

- [ ] **Step 3: Implement the tracker service**

Create an Effect service with these exact public shapes:

```ts
export type Identity = Readonly<{
  sessionID: SessionSchema.ID
  assistantMessageID: SessionMessage.ID
  toolCallID: string
  startedAt?: number
}>

export type Delegating = Pick<OmoRoutingRecommendation, "agent" | "background" | "source">

export interface Tracker {
  readonly analyzing: () => Effect.Effect<void>
  readonly selected: (recommendation: OmoRoutingRecommendation) => Effect.Effect<void>
  readonly delegating: (recommendation: Delegating) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
}

export interface Interface {
  readonly start: (identity: Identity) => Tracker
}

export type Publish = (activity: OmoRoutingEvent.OmoRoutingActivity) => Effect.Effect<unknown, unknown>
```

`makeTracker` must publish sequences `0`, `1`, `2`, and `3`, derive `durationMs` from the stable `startedAt`, map raw fallback text through `fallbackCode`, and wrap publication with `Effect.catchCause(() => Effect.void)`. The production layer obtains `EventV2Bridge.Service`; `node` depends on `EventV2Bridge.node`.

Export the factory with this signature so production and tests exercise the same implementation:

```ts
export function makeTracker(publish: Publish, identity: Identity): Tracker
```

The production service supplies `(activity) => events.publish(OmoRoutingEvent.Updated, activity)`; `makeTracker` owns the catch-all advisory boundary.

Use an allowlisted mapping, never substring output itself:

```ts
export function fallbackCode(reason: string | undefined): OmoRoutingEvent.FallbackCode | undefined {
  if (!reason) return
  const value = reason.toLowerCase()
  if (value.includes("timed out")) return "timeout"
  if (value.includes("ineligible")) return "ineligible_response"
  if (value.includes("incomplete") || value.includes("missing")) return "incomplete_response"
  if (value.includes("malformed")) return "invalid_response"
  if (value.includes("policy")) return "policy"
  if (value.includes("single eligible")) return "single_strategy"
  return "unavailable"
}
```

- [ ] **Step 4: Run tracker tests and typecheck**

Run from `packages/opencode`:

```powershell
bun test test/omo/routing-activity.test.ts
bun typecheck
```

Expected: PASS, including the publication-defect case.

- [ ] **Step 5: Commit the tracker**

```powershell
git add packages/opencode/src/omo/routing-activity.ts packages/opencode/test/omo/routing-activity.test.ts
git commit -m "feat(omo): publish routing activity"
```

### Task 3: Wire truthful runtime transitions

**Files:**
- Modify: `packages/opencode/src/omo/router.ts:25-151`
- Modify: `packages/opencode/src/omo/delegate-tool.ts:38-181`
- Modify: `packages/opencode/test/omo/router.test.ts`
- Modify: `packages/opencode/test/omo/delegate-tool.test.ts`

**Interfaces:**
- Consumes: `OmoRoutingActivity.Tracker` and `OmoRoutingActivity.Service.start(identity)` from Task 2.
- Produces: ordered, real runtime transitions and unconditional `cleared` cleanup.

- [ ] **Step 1: Add failing router boundary tests**

Extend `router.test.ts` with a recording tracker and assert:

```ts
const phases: string[] = []
const activity = {
  analyzing: () => Effect.sync(() => phases.push("analyzing")),
  selected: () => Effect.void,
  delegating: () => Effect.void,
  clear: () => Effect.void,
} satisfies OmoRoutingActivity.Tracker

const result = yield* router.route({
  summary: "Implement a parser fix",
  activity,
  explicit: { background: false },
})

expect(phases).toEqual(["analyzing"])
expect(result.source).toBe("explicit")
```

Add deterministic-policy and single-strategy cases with `expect(phases).toEqual([])`. These cases prove that an explicit source is not confused with whether SemIf actually ran.

- [ ] **Step 2: Add failing delegate lifecycle tests**

Extend the test `runtime` factory with an `activity` service whose tracker appends phases. Make the router stub invoke `request.activity?.analyzing()` before returning. Assert the success order:

```ts
expect(phases).toEqual(["analyzing", "selected", "delegating", "cleared"])
```

Add delegation failure and fiber interruption cases that both end in exactly one `cleared`. Add a tracker whose methods fail and assert the tool still returns the real delegation result.

- [ ] **Step 3: Run both focused tests and verify they fail**

Run from `packages/opencode`:

```powershell
bun test test/omo/router.test.ts test/omo/delegate-tool.test.ts
```

Expected: FAIL because the request and tool runtime do not yet carry the tracker.

- [ ] **Step 4: Emit `analyzing` at the SemIf boundary**

Add the optional tracker to `OmoRoutingRequest`:

```ts
readonly activity?: OmoRoutingActivity.Tracker
```

In `routeInternal`, after confirming SemIf status is `ready` and immediately before `decideWithTimeout`, execute:

```ts
if (request.activity) yield* request.activity.analyzing()
```

Do not emit it before config resolution, strategy generation, deterministic policy handling, status checks, or warmup fallback.

- [ ] **Step 5: Emit selection, delegation, and cleanup from the tool**

Add `activity: OmoRoutingActivity.Interface` to the tool runtime, obtain it in the node layer, and include `OmoRoutingActivity.node` in dependencies. At the beginning of `execute`, create one tracker:

```ts
const activity = runtime.activity.start({
  sessionID: context.sessionID,
  assistantMessageID: context.assistantMessageID,
  toolCallID: context.toolCallID,
})
```

Pass `activity` to `router.route`, call `yield* activity.selected(recommendation)` after routing, and call `yield* activity.delegating(recommendation)` immediately before `runtime.delegation.delegate(...)`. Add `Effect.ensuring(activity.clear())` outside the existing abort cleanup so every exit path clears exactly once without masking the tool result.

- [ ] **Step 6: Run focused tests and typecheck**

Run from `packages/opencode`:

```powershell
bun test test/omo/router.test.ts test/omo/delegate-tool.test.ts test/omo/routing-activity.test.ts
bun typecheck
```

Expected: all tests PASS and cancellation still aborts the delegation signal.

- [ ] **Step 7: Commit runtime transitions**

```powershell
git add packages/opencode/src/omo/router.ts packages/opencode/src/omo/delegate-tool.ts packages/opencode/test/omo/router.test.ts packages/opencode/test/omo/delegate-tool.test.ts
git commit -m "feat(omo): report routing phases"
```

### Task 4: Project ephemeral activity into session state

**Files:**
- Modify: `packages/app/src/context/server-session.ts:190-220, 477-510, 861-1050`
- Modify: `packages/app/src/context/server-session.test.ts`
- Modify: `packages/app/src/context/global-sync/types.ts:33-83`
- Modify: `packages/app/src/context/global-sync/session-cache.ts:1-45`
- Modify: `packages/app/src/context/global-sync/session-cache.test.ts`
- Modify: `packages/app/src/context/global-sync/child-store.ts:204-260`
- Modify: `packages/app/src/context/directory-sync.ts:10-35`

**Interfaces:**
- Consumes: `OmoRoutingEvent.OmoRoutingActivity` from Task 1.
- Produces: `data.omo_routing_activity[sessionID][identity]` and `data.omo_routing_watermark[sessionID][identity]` for timeline consumers.

- [ ] **Step 1: Write failing reducer lifecycle tests**

Add a local event builder to `server-session.test.ts`:

```ts
const routing = (input: {
  sessionID: string
  assistantMessageID: string
  toolCallID: string
  sequence: number
  state: OmoRoutingEvent.OmoRoutingActivity["state"]
}) => ({
  type: "session.omo.routing",
  properties: {
    ...input,
    startedAt: 100,
    updatedAt: 100 + input.sequence,
  },
})
```

Write separate tests for:

- ordered updates reaching `delegating`;
- duplicate and lower sequences being ignored;
- `cleared` hiding the activity while sequence `3` remains as a watermark;
- a delayed sequence `1` after clear remaining hidden;
- two sessions and two tool calls retaining independent records;
- a completed assistant message rejecting later activity;
- `session.status: idle`, V2 execution settlement, `server.connected`, and eviction clearing state.

- [ ] **Step 2: Run the server-session tests and verify they fail**

Run from `packages/app`:

```powershell
bun test --conditions=solid --preload ./happydom.ts ./src/context/server-session.test.ts ./src/context/global-sync/session-cache.test.ts
```

Expected: FAIL because the two routing stores do not exist.

- [ ] **Step 3: Add routing state to the shared session cache**

Add these fields to `State`, `createServerSession` data, and the child-store initializer:

```ts
omo_routing_activity: Record<string, Record<string, OmoRoutingEvent.OmoRoutingActivity | undefined> | undefined>
omo_routing_watermark: Record<string, Record<string, number | undefined> | undefined>
```

Add both names to `sessionFields` in `directory-sync.ts`. Extend `SessionCache` and `dropSessionCaches` so session eviction deletes both fields. Update `session-cache.test.ts` to seed and assert deletion of both records.

- [ ] **Step 4: Implement sequence-safe projection and cleanup**

Use an unambiguous identity key:

```ts
const routingActivityKey = (assistantMessageID: string, toolCallID: string) =>
  `${assistantMessageID}\u0000${toolCallID}`
```

In the `session.omo.routing` case:

```ts
const activity = event.properties as OmoRoutingEvent.OmoRoutingActivity
const key = routingActivityKey(activity.assistantMessageID, activity.toolCallID)
const watermark = data.omo_routing_watermark[activity.sessionID]?.[key] ?? -1
if (activity.sequence <= watermark) return
if (assistantSettled(activity.sessionID, activity.assistantMessageID)) return
setData(
  produce((draft) => {
    const watermarks = (draft.omo_routing_watermark[activity.sessionID] ??= {})
    watermarks[key] = activity.sequence
    const activities = (draft.omo_routing_activity[activity.sessionID] ??= {})
    activities[key] = activity.state.phase === "cleared" ? undefined : activity
  }),
)
return
```

Implement focused helpers to clear one assistant message, one session, or all sessions. Invoke them when an assistant `message.updated` has `time.completed` or an error, when status becomes idle, on V2 execution success/failure/interruption, on `server.connected`, and through existing cache eviction.

- [ ] **Step 5: Run reducer/cache tests and app typecheck**

Run from `packages/app`:

```powershell
bun test --conditions=solid --preload ./happydom.ts ./src/context/server-session.test.ts ./src/context/global-sync/session-cache.test.ts
bun typecheck
```

Expected: PASS; no activity leaks across session or tool identities.

- [ ] **Step 6: Commit session projection**

```powershell
git add packages/app/src/context/server-session.ts packages/app/src/context/server-session.test.ts packages/app/src/context/global-sync/types.ts packages/app/src/context/global-sync/session-cache.ts packages/app/src/context/global-sync/session-cache.test.ts packages/app/src/context/global-sync/child-store.ts packages/app/src/context/directory-sync.ts
git commit -m "feat(app): track OMO routing activity"
```

### Task 5: Render the compact accessible timeline status

**Files:**
- Create: `packages/app/src/pages/session/timeline/omo-routing-status.ts`
- Create: `packages/app/src/pages/session/timeline/omo-routing-status.test.ts`
- Create: `packages/session-ui/src/components/thinking-status.test.ts`
- Modify: `packages/session-ui/src/components/thinking-status.tsx:1-100`
- Modify: `packages/session-ui/src/components/thinking-status.css`
- Modify: `packages/app/src/pages/session/timeline/rows.ts:1-180`
- Modify: `packages/app/src/pages/session/timeline/rows-current.test.ts`
- Modify: `packages/app/src/pages/session/timeline/projection.ts:1-50`
- Modify: `packages/app/src/pages/session/timeline/projection.test.ts`
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx:135-147, 275-355, 1208-1226`
- Modify: `packages/ui/src/i18n/en.ts:90-105`
- Modify: `packages/ui/src/i18n/br.ts:98-115`

**Interfaces:**
- Consumes: the per-session activity maps from Task 4.
- Produces: `routingStatusLabel(activity, t)`, a `Thinking` row with optional activity, and a shared `ThinkingStatus` supporting an override label and elapsed-only detail mode.

- [ ] **Step 1: Write failing label and elapsed-time tests**

Test all approved mappings with a deterministic translator:

```ts
const t = (key: UiI18nKey, params?: UiI18nParams) => `${key}:${params?.agent ?? ""}`

expect(routingStatusLabel(analyzing, t)).toBe("ui.sessionTurn.status.semifAnalyzing:")
expect(routingStatusLabel(selectedSemif, t)).toBe("ui.sessionTurn.status.specialistSelected:Fixer")
expect(routingStatusLabel(selectedDeterministic, t)).toBe("ui.sessionTurn.status.deterministicRouting:Fixer")
expect(routingStatusLabel(selectedExplicit, t)).toBe("ui.sessionTurn.status.specialistSpecified:Fixer")
expect(routingStatusLabel(delegating, t)).toBe("ui.sessionTurn.status.startingSpecialist:Fixer")
```

Load `packages/ui/src/i18n/en.ts` and `br.ts` with dynamic imports in the same test and assert the exact approved strings for all six keys. This pins actual locale content rather than only mapper keys.

In `thinking-status.test.ts`, test `formatElapsed(startedAt, now, locale)` at `0`, `999`, `1000`, `1200`, and a negative clock skew. Assert `1.2s` for English and `1,2s` for Brazilian Portuguese. In `rows-current.test.ts`, assert that the newest activity for the active assistant is attached to `TimelineRow.Thinking`, while an unrelated session/tool activity is not.

- [ ] **Step 2: Run focused UI tests and verify they fail**

Run:

```powershell
Set-Location packages/session-ui
bun test src/components/thinking-status.test.ts
Set-Location ../app
bun test --conditions=solid --preload ./happydom.ts ./src/pages/session/timeline/omo-routing-status.test.ts ./src/pages/session/timeline/rows-current.test.ts ./src/pages/session/timeline/projection.test.ts
```

Expected: FAIL because the label mapper, elapsed helper, and row activity input do not exist.

- [ ] **Step 3: Add English and Brazilian Portuguese copy**

Add the same keys to `en.ts` and `br.ts`:

```ts
"ui.sessionTurn.status.semifAnalyzing": "SemIf analyzing",
"ui.sessionTurn.status.specialistSelected": "Specialist selected: {{agent}}",
"ui.sessionTurn.status.deterministicRouting": "Deterministic routing · {{agent}}",
"ui.sessionTurn.status.specialistSpecified": "Specialist specified: {{agent}}",
"ui.sessionTurn.status.startingSpecialist": "Starting {{agent}}",
"ui.sessionTurn.status.startingSpecialistBackground": "Starting {{agent}} in the background",
```

Brazilian Portuguese values are `SemIf analisando`, `Especialista selecionado: {{agent}}`, `Roteamento determinístico · {{agent}}`, `Especialista definido: {{agent}}`, `Iniciando {{agent}}`, and `Iniciando {{agent}} em segundo plano`.

- [ ] **Step 4: Implement the pure label mapper**

Create `omo-routing-status.ts` with `specialistLabel` and an exhaustive phase/source switch. `analyzing` maps to the SemIf label; `selected` uses its source; `delegating` uses foreground/background copy. `cleared` returns `undefined` and is never rendered.

```ts
export function specialistLabel(agent: Omo.AgentID) {
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}
```

Use the UI i18n parameter types directly; do not alias imports.

- [ ] **Step 5: Extend the shared thinking presentation**

Add optional props without changing existing callers:

```ts
label?: string
startedAt?: number
details?: "all" | "elapsed"
```

Export and use an elapsed formatter that stays hidden for the first second and floors to tenths so it never overstates elapsed time:

```ts
export function formatElapsed(startedAt: number | undefined, now: number, locale: string) {
  if (startedAt === undefined) return ""
  const elapsed = Math.max(0, now - startedAt)
  if (elapsed < 1_000) return ""
  const seconds = Math.floor(elapsed / 100) / 10
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(seconds)}s`
}
```

Use `props.label ?? i18n.t("ui.sessionTurn.status.thinking")`. In elapsed-only mode, tick visually every 100 ms, hide decision/token counters, and render the localized `· 1.2s`/`· 1,2s` form only after one second. Keep the existing one-second whole-number behavior for full-statistics callers. Put the phase label in `aria-live="polite"`; keep the timer outside that live region with an accessible static label so it is not announced every tick. Retain `TextShimmer`, whose CSS already disables animation under `prefers-reduced-motion`, and keep the row on one line.

- [ ] **Step 6: Carry activity through the timeline projection**

Extend `TimelineRowMap.Thinking` with:

```ts
routingActivity?: OmoRoutingEvent.OmoRoutingActivity
```

Add `routingActivities` to `constructSessionMessageRows`, `constructMessageRows`, and `createTimelineProjection`. For the active turn, choose the visible activity with the greatest `updatedAt` that matches an assistant message in that turn. If the assistant has not projected yet, allow the latest activity in the current session to attach only to the active final turn. Never attach activity to an inactive historical turn.

- [ ] **Step 7: Render the shared status from `MessageTimeline`**

Create a memo from the current session map:

```ts
const routingActivities = createMemo(() => {
  const id = sessionID()
  if (!id) return []
  return Object.values(sync().data.omo_routing_activity[id] ?? {}).filter(
    (activity): activity is OmoRoutingEvent.OmoRoutingActivity => activity !== undefined,
  )
})
```

Pass it into `createTimelineProjection`. Replace the direct `TextShimmer` in `TimelineThinkingRow` with `ThinkingStatus`, using `routingStatusLabel` when activity exists, `details="elapsed"`, and `startedAt` from activity or the current user/assistant message. Preserve the existing reasoning heading below the compact status.

- [ ] **Step 8: Run focused tests and package typechecks**

Run:

```powershell
Set-Location packages/session-ui
bun test src/components/thinking-status.test.ts
bun typecheck
Set-Location ../ui
bun typecheck
Set-Location ../app
bun test --conditions=solid --preload ./happydom.ts ./src/pages/session/timeline/omo-routing-status.test.ts ./src/pages/session/timeline/rows-current.test.ts ./src/pages/session/timeline/projection.test.ts
bun typecheck
```

Expected: PASS; existing generic thinking callers retain their previous full statistics.

- [ ] **Step 9: Commit the timeline UI**

```powershell
git add packages/session-ui/src/components/thinking-status.tsx packages/session-ui/src/components/thinking-status.css packages/session-ui/src/components/thinking-status.test.ts packages/app/src/pages/session/timeline packages/ui/src/i18n/en.ts packages/ui/src/i18n/br.ts
git commit -m "feat(app): show SemIf routing progress"
```

### Task 6: Prove the user story and complete verification

**Files:**
- Create: `packages/app/e2e/user-story/omo-routing-feedback.spec.ts`
- Modify only if the fixture needs a reusable typed envelope: `packages/app/e2e/utils/sse-transport.ts`
- Modify: `docs/omo/e2e-review.md`
- Modify: `docs/omo/verification.md`

**Interfaces:**
- Consumes: `session.omo.routing` SSE payload and timeline semantics from Tasks 1-5.
- Produces: deterministic browser proof and recorded verification evidence.

- [ ] **Step 1: Write the controlled SSE E2E test**

Use `mockNextCodeServer` for HTTP data and `installSseTransport` for live events. Seed one busy parent session with a user message and an incomplete assistant message. After navigation and SSE connection, send one event at a time and use web-first assertions:

```ts
await transport.send(envelope({ phase: "analyzing" }, 0))
await expect(page.locator('[data-slot="thinking-status-label"]')).toContainText("SemIf analyzing")

await transport.send(envelope({
  phase: "selected",
  agent: "fixer",
  source: "semif",
  background: false,
  verification: "tests",
  durationMs: 40,
}, 1))
await expect(page.locator('[data-slot="thinking-status-label"]')).toContainText("Specialist selected: Fixer")

await transport.send(envelope({
  phase: "delegating",
  agent: "fixer",
  source: "semif",
  background: false,
}, 2))
await expect(page.locator('[data-slot="thinking-status-label"]')).toContainText("Starting Fixer")

await transport.send(envelope({ phase: "cleared" }, 3))
await expect(page.locator('[data-slot="thinking-status-label"]')).toContainText("Thinking")
```

No `waitForTimeout` or fixed sleep is permitted.

- [ ] **Step 2: Add fallback, explicit, cancellation, and isolation cases**

In the same spec, add:

- a deterministic `selected` event that renders `Deterministic routing · Fixer` without ever observing a SemIf label;
- an explicit `selected` event that renders `Specialist specified: Oracle`;
- a clear followed by a stale lower sequence that remains generic;
- two tabs for different sessions where an event changes only its owning tab;
- two tool call IDs in one session where the newest `updatedAt` wins and clearing it reveals the still-active older call;
- session idle after cancellation, which removes the entire thinking row.

Use SSE acknowledgements plus Playwright's `toHaveText`, `toContainText`, and negative text assertions; do not coordinate with wall-clock delays.

- [ ] **Step 3: Run the focused E2E repeatedly**

Run from `packages/app`:

```powershell
bunx playwright test e2e/user-story/omo-routing-feedback.spec.ts --repeat-each=3
```

Expected: 3/3 passes for every case with no retries or fixed waits.

- [ ] **Step 4: Run the complete focused verification matrix**

Run each command from the shown package:

```powershell
Set-Location packages/schema
bun test test/omo-routing-event.test.ts test/event-manifest.test.ts
bun typecheck
Set-Location ../core
bun test test/omo.test.ts
bun typecheck
Set-Location ../opencode
bun test test/omo/routing-activity.test.ts test/omo/router.test.ts test/omo/delegate-tool.test.ts
bun typecheck
Set-Location ../client
bun run check:generated
bun typecheck
Set-Location ../sdk/js
bun typecheck
Set-Location ../../session-ui
bun test src/components/thinking-status.test.ts
bun typecheck
Set-Location ../ui
bun typecheck
Set-Location ../app
bun test --conditions=solid --preload ./happydom.ts ./src/context/server-session.test.ts ./src/context/global-sync/session-cache.test.ts ./src/pages/session/timeline/omo-routing-status.test.ts ./src/pages/session/timeline/rows-current.test.ts ./src/pages/session/timeline/projection.test.ts
bun typecheck
bunx playwright test e2e/user-story/omo-routing-feedback.spec.ts
```

Expected: every command PASS and `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Perform the E2E implementation review**

Update `docs/omo/e2e-review.md` with evidence for unique semantic locators, isolated session IDs, controlled SSE phase boundaries, absence of sleeps, repeated-run results, cancellation cleanup, and concurrent-session isolation. Update `docs/omo/verification.md` with the exact commands and results from Step 4.

- [ ] **Step 6: Commit E2E proof and verification records**

```powershell
git add packages/app/e2e/user-story/omo-routing-feedback.spec.ts packages/app/e2e/utils/sse-transport.ts docs/omo/e2e-review.md docs/omo/verification.md
git commit -m "test(omo): verify routing feedback"
```

- [ ] **Step 7: Review the whole branch diff**

Run from the repository root:

```powershell
git diff --check db332b4846...HEAD
git diff --stat db332b4846...HEAD
git status --short
```

Confirm the working tree is clean, generated sources match their generators, the event is absent from durable manifests, and no raw routing inputs or failure strings cross the event boundary.
