# SemIf Routing Feedback Design

**Date:** 2026-09-20
**Status:** Approved in conversation
**Depends on:** `2026-09-19-native-omo-semif-design.md`

## Intent

Give the user immediate, truthful feedback while native OMO routing is active. Today the new session timeline renders only a generic `Pensando` label while SemIf selects a strategy, so a submitted message can appear stalled even though routing is progressing.

The new feedback stays compact and reports only observable runtime phases:

```text
SemIf analisando · 1,2s
Especialista selecionado: Fixer
Iniciando Fixer
```

The UI must not invent percentages, expose chain-of-thought, or imply that SemIf ran when routing was explicit or deterministic.

## Architecture

Introduce a session-scoped, non-durable OMO routing activity event. Do not extend the generic session status union (`idle`, `busy`, and `retry`): routing is a short-lived detail of one tool call, not a new lifecycle state for every session consumer.

The runtime flow is:

```text
omo_delegate starts
  -> OmoRouter begins a real SemIf decision
     -> analyzing
  -> OmoRouter returns a recommendation
     -> selected
  -> DelegationService is invoked
     -> delegating
  -> tool succeeds, fails, or is interrupted
     -> cleared
```

`analyzing` is emitted immediately before the actual `semif.decide(...)` call. A deterministic path or a fully resolved explicit path must not emit that phase. A partial explicit override may still emit `analyzing` when SemIf genuinely decides the remaining fields. `selected` describes the final normalized recommendation, including a deterministic fallback after an attempted SemIf decision. `delegating` begins immediately before delegation is invoked.

The event is omitted from durable session history. It is delivered over the existing live event transport and is discarded after completion, failure, interruption, disconnection, or session replacement. Durable messages and tool parts remain the source of truth.

## Event Contract

Use one discriminated activity payload with four phases:

```ts
type OmoRoutingActivity = {
  sessionID: SessionID
  assistantMessageID: SessionMessage.ID
  toolCallID: string
  sequence: number
  startedAt: number
  updatedAt: number
  state:
    | { phase: "analyzing" }
    | {
        phase: "selected"
        agent: AgentID
        source: "semif" | "deterministic" | "explicit"
        background: boolean
        verification: Verification
        durationMs: number
        fallback?: OmoRoutingFallbackCode
      }
    | {
        phase: "delegating"
        agent: AgentID
        source: "semif" | "deterministic" | "explicit"
        background: boolean
      }
    | { phase: "cleared" }
}
```

The concrete event name should follow the repository's session event conventions and be registered in the public event inventory. Omitting durable options makes the EventV2 definition live-only. Because this changes a public Protocol surface, regenerate the client from `packages/client` and never edit generated sources directly.

`toolCallID` is the activity identity within an assistant message. `sequence` starts at zero and increases for each transition. The application accepts a transition only when its sequence is newer than the stored watermark for the same identity. A `cleared` transition hides the activity but retains its watermark until the associated assistant message settles. This prevents a delayed `selected` event from recreating an activity after `delegating` or `cleared`.

The event permits only bounded, typed routing facts. It must not contain the task prompt, evidence, option descriptions, alternative scores, model paths, arbitrary exception messages, or raw fallback reasons. When fallback context is useful to the UI, map it to a small allowlisted reason code. The initial UI does not need to render that reason.

## Runtime Ownership

The OMO runtime owns publication. Tool context already supplies the session, assistant-message, and tool-call identifiers needed for correlation.

The delegate tool passes that identity into the routing operation. The router emits `analyzing` only at the boundary where it actually calls SemIf. After routing returns, the delegate tool emits `selected`, then `delegating` before calling the existing delegation service.

Cleanup is unconditional. An Effect finalizer emits `cleared` for success, typed failure, cancellation, interruption, and defects. Cleanup must not replace or mask the original result. Event publication is advisory: failure to publish visual progress cannot fail routing or delegation.

The activity publisher should remain an OMO/runtime concern and use the existing event bridge. It must not introduce a Core-to-Server dependency or place UI concerns in SemIf service code.

## Application State

The application stores at most the latest visible routing activity and sequence watermark for each session and tool identity. The event reducer:

- validates session, assistant-message, and tool-call correlation;
- ignores a sequence that is equal to or older than the current value;
- hides matching activity on `cleared` while retaining its ordering watermark;
- rejects new activity for an assistant message already known to be settled;
- clears visible activity and its watermark when the associated assistant message settles, the connection is replaced, or the session is removed;
- never applies one session's activity to another timeline.

The timeline projection attaches the current activity to its thinking row. No activity produces the generic thinking state, preserving behavior for sessions that do not use native OMO.

The new timeline currently bypasses the richer shared thinking presentation. Extract or reuse one compact status presentation so elapsed-time and accessibility behavior are consistent instead of maintaining a second independent implementation.

## Visual Behavior

The indicator occupies one stable line and changes its text as facts become available:

| Runtime state | Portuguese (Brazil) | English |
| --- | --- | --- |
| Generic thinking | `Pensando · 1,2s` | `Thinking · 1.2s` |
| SemIf decision | `SemIf analisando · 1,2s` | `SemIf analyzing · 1.2s` |
| SemIf selection | `Especialista selecionado: Fixer` | `Specialist selected: Fixer` |
| Deterministic selection | `Roteamento determinístico · Fixer` | `Deterministic routing · Fixer` |
| Explicit selection | `Especialista definido: Fixer` | `Specialist specified: Fixer` |
| Delegation start | `Iniciando Fixer` | `Starting Fixer` |

Elapsed time appears after the first second and is derived locally from `startedAt`; no timer event is sent by the server. The timer may update visually, but assistive technology must not announce every tick.

Phase changes render immediately. Do not add an artificial minimum duration to make fast phases visible. A naturally superseded selection may therefore be brief. Stable dimensions should prevent text changes from shifting surrounding content.

The specialist label is presentation-friendly while the event retains the canonical agent identifier. Background execution may use an accessible description such as `Iniciando Fixer em segundo plano`, without turning the compact visual line into a verbose status report.

## Accessibility and Motion

- Announce phase changes with a polite live region.
- Keep the changing timer outside the live announcement or mark it appropriately so seconds are not repeatedly spoken.
- Preserve sufficient contrast in light and dark themes.
- Reuse the existing shimmer only when motion is allowed.
- Under `prefers-reduced-motion`, render a static label without losing any information.
- Expose semantic state text to tests and assistive technology instead of relying on animation or color.

## Failure and Recovery

- A SemIf timeout or malformed result transitions to a deterministic `selected` state rather than an error-styled state.
- Fully resolved explicit routing uses `selected` with source `explicit` and never claims SemIf analysis. Partial overrides may show genuine SemIf analysis before the explicit-source selection.
- Permission denial, delegation failure, and tool failure continue through existing error presentation.
- Cancellation and interruption clear the routing indicator promptly.
- A live-event transport failure leaves the generic `Pensando` indicator available and never blocks execution.
- Reconnection does not attempt to replay ephemeral routing phases. The current durable tool/message state determines what remains visible.

## Verification Strategy

### Contract and Runtime

- Validate every phase and reject fields outside the bounded public schema.
- Verify `analyzing -> selected -> delegating -> cleared` for a successful SemIf route.
- Verify deterministic and fully resolved explicit routes never emit a false `analyzing` phase, while partial overrides emit it only when SemIf is actually called.
- Verify SemIf failure produces deterministic selection and preserves the real delegation result.
- Verify cleanup on success, routing failure, delegation failure, cancellation, and interruption.
- Verify progress publication failure cannot fail the tool.

### Application

- Verify the reducer isolates concurrent sessions and tool calls.
- Verify stale and duplicate sequences are ignored.
- Verify all settlement and disposal paths clear ephemeral state.
- Verify the timeline uses OMO activity when present and generic thinking otherwise.
- Verify Portuguese and English labels, elapsed-time formatting, specialist labels, and reduced-motion behavior.
- Verify live-region announcements happen on phase changes but not timer ticks.

### End to End

Use controlled SemIf and delegation delays rather than arbitrary sleeps. After message submission, assert that the UI shows SemIf analysis before the tool result, then the selected specialist and delegation phase in order. Cover deterministic fallback, explicit selection, cancellation, and two concurrent sessions. Use semantic locators and web-first assertions.

Run tests and typechecks from their package directories. Run public client generation when the event contract is added.

## Out of Scope

- Percentage-based progress or estimated completion time.
- Chain-of-thought, prompt, evidence, model internals, or SemIf score disclosure.
- Durable replay of routing activity.
- A redesign of tool cards or the complete session timeline.
- Changes to SemIf model acquisition and process lifecycle UI.
- Artificial delays intended only to expose otherwise instantaneous phases.

## Acceptance Criteria

- Sending a message that reaches SemIf immediately shows `SemIf analisando` instead of an unexplained generic wait.
- The selected specialist and delegation start are shown from real runtime transitions.
- Deterministic and explicit routes use truthful source-specific text.
- A session without OMO still shows generic thinking with elapsed time.
- Concurrent sessions and repeated tool calls cannot overwrite each other's status.
- Success, failure, interruption, and cancellation leave no stale indicator.
- No sensitive routing input or raw failure detail reaches the public event.
- The indicator works in Portuguese and English, with reduced motion and assistive technology.
- Focused runtime, reducer, component, and E2E tests pass without fixed sleeps.
