# Semif turn footer

**Status:** approved for implementation planning
**Baseline:** `origin/dev` @ `9481da071`
**Non-goals:** token-savings estimates, new protocol or session events, persisting routing activity after it clears, changing `omo_delegate` or `semif_decide` rows, composer, theme, or locale files other than the English UI dictionary

## Problem

The closing line of an assistant response is `Build · Nemotron 3 Ultra (free) · 1m 2s`. It names the agent, the answering model, and the turn duration. It does not say whether Semif took part.

While the turn is open, thinking can show "SemIf analyzing" and a decision count. That status leaves with the turn. The routing event is deleted when delegation finishes and when the assistant message settles, so the footer cannot read it after the fact.

## Product rule

The same closing line always ends with a Semif phrase. The phrase states only facts already stored on the turn's tool parts. It does not estimate tokens the frontier model avoided spending.

## Decisions (locked)

| Axis | Choice |
|---|---|
| Placement | The existing assistant meta line, after agent, model, duration, and Interrupted |
| Absence | Always visible: `No Semif` when Semif did not route and no local decision completed |
| Routing evidence | A completed, running, pending, or error `omo_delegate` part whose metadata `source` is `semif` |
| Decision evidence | A `semif_decide` part whose tool status is `completed` |
| Local tokens | Sum of finite, non-negative `metadata.input_tokens` on those completed decisions |
| Zero tokens | Omit the token segment. A decision with a missing or invalid token count still counts as a decision |
| Scope | Every tool part on assistant messages parented to that user message |
| Where it renders | Once, on the existing copy row of the last non-empty text part of the last assistant message in the turn that has one |
| No text part | Do not add a new row |
| Streaming | The phrase updates as tool parts complete. Before any Semif evidence it already says `No Semif` |
| Copy language | English keys in `packages/ui/src/i18n/en.ts`. Other locales keep inheriting that English through the existing base dictionary |

## Copy

The meta join stays `" · "`.

| Facts | Phrase |
|---|---|
| No Semif source and zero completed decisions | `No Semif` |
| Semif source and zero completed decisions | `Semif` |
| One or more completed decisions and token sum `0` | `Semif · 1 decision` or `Semif · 2 decisions` |
| One or more completed decisions and token sum above `0` | `Semif · 2 decisions · 840 tokens` |

Token text uses the thinking-status compact rule: under 1000, a rounded integer; otherwise `Intl.NumberFormat` compact notation with one fraction digit, in the active UI locale.

`deterministic` and `explicit` delegate sources do not count as Semif. One Semif delegate is enough. Interrupted stays its own segment and keeps its current position, before the Semif phrase.

## Architecture

```text
MessageTimeline
  turn tool parts  ->  semifFooterLabel(parts, i18n)
  last text part meta  ->  agent · model · duration · Interrupted · label
```

`semifFooterLabel` lives in `packages/session-ui/src/components/semif-footer.ts`. It is synchronous. It reads `omo_delegate` provenance through the existing `omoDelegateView` and reads `semif_decide` counts from part status plus metadata. It returns the phrase, never an empty string.

Keys, all in the English UI dictionary:

- `ui.message.semif.none` → `No Semif`
- `ui.message.semif.routed` → `Semif`
- `ui.message.semif.tokens` → `{{tokens}} tokens`
- `ui.message.semif.decisions`, added to `UI_PLURAL_KEYS`, with `.one` → `{{count}} decision` and `.other` → `{{count}} decisions`

A decision phrase is `Semif`, the plural, and the token phrase only when the sum is above zero, joined with ` · `.

`MessageTimeline` passes that phrase only into the text part that already owns the copy row for the last assistant message in the turn that has a non-empty text part. Earlier text parts keep their current meta. When a later assistant message gains text, the phrase moves with that copy row.

No change to routing publication, tool metadata, or the delegate and decide renderers.

## Errors and edges

- A delegate with no `source`, or with `source` other than `semif`, does not route the turn.
- A `semif_decide` part that is pending, running, or error does not increment the decision count and contributes no tokens.
- `input_tokens` that is missing, not a number, negative, or non-finite contributes `0`.
- The phrase is the whole Semif fact. There is no tooltip, chip, or second line.

## Testing

`packages/session-ui/src/components/semif-footer.test.ts` covers:

- no matching parts → `No Semif`
- one Semif delegate and no decisions → `Semif`
- two completed decisions with tokens `400` and `440` → `Semif · 2 decisions · 840 tokens`
- a completed decision with `input_tokens` of `1500` renders the token segment from the compact formatter, not the raw integer
- completed decisions whose tokens are missing or zero → decision plural and no token segment
- pending or error `semif_decide` ignored
- `deterministic` delegate ignored
- one Semif delegate among other delegates still routes

Run from `packages/session-ui` with `bun test`.
