# Semif Turn Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant closing line always ends with whether Semif routed the turn, how many local decisions completed, and how many local tokens those decisions spent.

**Architecture:** A pure `semifFooterLabel` reads tool parts already stored on the turn. `MessageTimeline` passes that phrase into the existing copy row of the last text part. The text part appends it to the current agent · model · duration line.

**Tech Stack:** SolidJS, Bun test, `@opencode-ai/ui` i18n, `@opencode-ai/session-ui`.

## Global Constraints

- No token-savings estimate.
- No new protocol or session event.
- Do not persist routing activity after it clears.
- Do not change the `omo_delegate` or `semif_decide` row renderers.
- English copy lives only in `packages/ui/src/i18n/en.ts`. Do not edit other locale files.
- Meta separator stays `" · "`.
- `omo_delegate` counts as Semif routing when `omoDelegateView(...).source === "semif"`, including pending, running, completed, and error.
- Only a `semif_decide` part with status `completed` counts as a decision.
- Sum finite, non-negative `metadata.input_tokens`. Missing, non-numeric, negative, or non-finite values contribute `0`. A decision still counts.
- Omit the token segment when the sum is `0`.
- Scope is every part on assistant messages parented to that user message.
- Render the phrase once, on the part id `assistantCopyPartID` already returns. Do not change `workingTurn` or `assistantCopyPartID`. While the turn is working, that id is `null` and the copy row stays hidden.
- `deterministic` and `explicit` do not count as Semif. One Semif delegate is enough.
- Interrupted stays before the Semif phrase.
- Tests run from the package directory, not the repo root.

## File structure

- Create `packages/session-ui/src/components/semif-footer.ts`: phrase from parts. No Solid.
- Create `packages/session-ui/src/components/semif-footer.test.ts`: the phrase cases.
- Modify `packages/ui/src/i18n/en.ts`: the four English strings.
- Modify `packages/ui/src/context/i18n.tsx`: register the decisions plural key.
- Modify `packages/session-ui/package.json`: export the new module.
- Modify `packages/session-ui/src/components/message-part.tsx`: accept the phrase and append it in the text meta.
- Modify `packages/app/src/pages/session/timeline/message-timeline.tsx`: compute the phrase for the turn and pass it only for the copy part.

---

### Task 1: Semif footer phrase

**Files:**
- Create: `packages/session-ui/src/components/semif-footer.ts`
- Create: `packages/session-ui/src/components/semif-footer.test.ts`
- Modify: `packages/ui/src/i18n/en.ts`
- Modify: `packages/ui/src/context/i18n.tsx`

**Interfaces:**
- Consumes: `omoDelegateView(metadata, status)` from `packages/session-ui/src/components/omo-delegate.ts`.
- Produces:
  - `semifFooterLabel(input: { parts: readonly SemifFooterPart[]; locale: string; t: (key: UiI18nKey, params?: UiI18nParams) => string; plural: (key: UiI18nPluralKey, count: number, params?: UiI18nParams) => string }): string`
  - `semifFooterForPart(copyPartID: string | null | undefined, partID: string, label: string): string | undefined`
  - `SemifFooterPart = { type: string; tool?: string; state?: { status?: string; metadata?: Record<string, unknown> } }`

- [ ] **Step 1: Add the English keys**

In `packages/ui/src/context/i18n.tsx`, add the plural key to the existing array:

```ts
export const UI_PLURAL_KEYS = [
  "ui.sessionTurn.diffs.changed",
  "ui.sessionTurn.thinking.decisions",
  "ui.message.semif.decisions",
  "ui.messagePart.context.read",
  "ui.messagePart.context.search",
  "ui.messagePart.context.list",
  "ui.messagePart.edit",
] as const
```

In `packages/ui/src/i18n/en.ts`, after `"ui.message.interrupted"`:

```ts
  "ui.message.semif.none": "No Semif",
  "ui.message.semif.routed": "Semif",
  "ui.message.semif.tokens": "{{tokens}} tokens",
  "ui.message.semif.decisions.one": "{{count}} decision",
  "ui.message.semif.decisions.other": "{{count}} decisions",
```

- [ ] **Step 2: Write the failing test**

Create `packages/session-ui/src/components/semif-footer.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { UiI18nKey, UiI18nParams, UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"
import { semifFooterForPart, semifFooterLabel, type SemifFooterPart } from "./semif-footer"

const dict: Record<string, string> = {
  "ui.message.semif.none": "No Semif",
  "ui.message.semif.routed": "Semif",
  "ui.message.semif.tokens": "{{tokens}} tokens",
  "ui.message.semif.decisions.one": "{{count}} decision",
  "ui.message.semif.decisions.other": "{{count}} decisions",
}

function fill(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, key: string) => {
    const value = params[key]
    return value === undefined ? "" : String(value)
  })
}

const t = (key: UiI18nKey, params?: UiI18nParams) => fill(dict[key] ?? key, params)
const plural = (key: UiI18nPluralKey, count: number, params?: UiI18nParams) => {
  const category = count === 1 ? "one" : "other"
  return fill(dict[`${key}.${category}`] ?? "", { ...params, count })
}

function delegate(source: string, status = "completed"): SemifFooterPart {
  return { type: "tool", tool: "omo_delegate", state: { status, metadata: { source } } }
}

function decide(input_tokens: unknown, status = "completed"): SemifFooterPart {
  return { type: "tool", tool: "semif_decide", state: { status, metadata: { input_tokens } } }
}

function label(parts: readonly SemifFooterPart[], locale = "en") {
  return semifFooterLabel({ parts, locale, t, plural })
}

describe("semifFooterLabel", () => {
  test("says No Semif when the turn has no Semif evidence", () => {
    expect(label([])).toBe("No Semif")
    expect(label([delegate("deterministic"), delegate("explicit")])).toBe("No Semif")
    expect(label([{ type: "text" }, decide(10, "pending"), decide(10, "error"), decide(10, "running")])).toBe(
      "No Semif",
    )
  })

  test("says Semif when a delegate was routed by Semif and no decision completed", () => {
    expect(label([delegate("deterministic"), delegate("semif", "running")])).toBe("Semif")
    expect(label([delegate("semif", "error")])).toBe("Semif")
  })

  test("counts completed decisions and sums local tokens", () => {
    expect(label([decide(400), decide(440), decide(-5), decide(Number.NaN), decide(undefined)])).toBe(
      "Semif · 5 decisions · 840 tokens",
    )
    expect(label([decide(0), decide(undefined)])).toBe("Semif · 2 decisions")
    expect(label([decide(12)])).toBe("Semif · 1 decision · 12 tokens")
  })

  test("formats token totals at 1000 and above with compact notation", () => {
    const text = label([decide(1500)])
    expect(text.startsWith("Semif · 1 decision · ")).toBe(true)
    expect(text.endsWith(" tokens")).toBe(true)
    expect(text).not.toContain("1500")
  })
})

describe("semifFooterForPart", () => {
  test("returns the phrase only for the copy part", () => {
    expect(semifFooterForPart("part_copy", "part_copy", "No Semif")).toBe("No Semif")
    expect(semifFooterForPart("part_copy", "part_other", "No Semif")).toBeUndefined()
    expect(semifFooterForPart(null, "part_copy", "No Semif")).toBeUndefined()
    expect(semifFooterForPart(undefined, "part_copy", "No Semif")).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

From `packages/session-ui`:

```bash
bun test --conditions=browser src/components/semif-footer.test.ts
```

Expected: FAIL because `./semif-footer` does not exist.

- [ ] **Step 4: Write the phrase**

Create `packages/session-ui/src/components/semif-footer.ts`:

```ts
import type { UiI18nKey, UiI18nParams, UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"
import { omoDelegateView } from "./omo-delegate"

export type SemifFooterPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    metadata?: Record<string, unknown>
  }
}

export function semifFooterForPart(copyPartID: string | null | undefined, partID: string, label: string) {
  if (copyPartID !== partID) return
  return label
}

export function semifFooterLabel(input: {
  parts: readonly SemifFooterPart[]
  locale: string
  t: (key: UiI18nKey, params?: UiI18nParams) => string
  plural: (key: UiI18nPluralKey, count: number, params?: UiI18nParams) => string
}) {
  const tools = input.parts.filter((part) => part.type === "tool")
  const routed = tools.some(
    (part) => part.tool === "omo_delegate" && omoDelegateView(part.state?.metadata, part.state?.status).source === "semif",
  )
  const decisions = tools.filter((part) => part.tool === "semif_decide" && part.state?.status === "completed")
  const tokens = decisions.reduce((sum, part) => sum + localTokens(part.state?.metadata?.input_tokens), 0)
  if (!routed && decisions.length === 0) return input.t("ui.message.semif.none")
  if (decisions.length === 0) return input.t("ui.message.semif.routed")
  const phrase = `${input.t("ui.message.semif.routed")} · ${input.plural("ui.message.semif.decisions", decisions.length)}`
  if (tokens <= 0) return phrase
  return `${phrase} · ${input.t("ui.message.semif.tokens", { tokens: compactTokenCount(tokens, input.locale) })}`
}

function localTokens(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return value
}

function compactTokenCount(value: number, locale: string) {
  if (value < 1000) return Math.round(value).toString()
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}
```

- [ ] **Step 5: Run the test to verify it passes**

From `packages/session-ui`:

```bash
bun test --conditions=browser src/components/semif-footer.test.ts
```

Expected: all tests PASS.

From `packages/ui` and `packages/session-ui`:

```bash
bun typecheck
```

Expected: both succeed. Do not treat `packages/app` typecheck as a gate; it is already red on duplicate i18n keys.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/context/i18n.tsx packages/ui/src/i18n/en.ts packages/session-ui/src/components/semif-footer.ts packages/session-ui/src/components/semif-footer.test.ts
git commit -m "feat(session-ui): label whether a turn used semif"
```

---

### Task 2: Show the phrase on the closing line

**Files:**
- Modify: `packages/session-ui/package.json` exports
- Modify: `packages/session-ui/src/components/message-part.tsx` (`MessagePartProps`, `Part`, text `meta`)
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx` (import, turn parts, `MessagePart` props)

**Interfaces:**
- Consumes: `semifFooterLabel` and `semifFooterForPart` from Task 1.
- Produces: `MessagePartProps.semifFooter?: string`, rendered after Interrupted on the text meta line.

- [ ] **Step 1: Export the module**

In `packages/session-ui/package.json`, add this export next to `"./message-part-text"`:

```json
"./semif-footer": "./src/components/semif-footer.ts",
```

- [ ] **Step 2: Accept the phrase on the text part**

Add the field to `MessagePartProps`:

```ts
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  semifFooter?: string
  useV2Actions?: boolean
```

Forward it in `Part`:

```tsx
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
        semifFooter={props.semifFooter}
        useV2Actions={props.useV2Actions}
```

In `TextPartDisplay`, append it inside `meta`:

```ts
    const items = [
      agent ? agent[0]?.toUpperCase() + agent.slice(1) : "",
      model(),
      duration(),
      interrupted() ? i18n.t("ui.message.interrupted") : "",
      props.semifFooter ?? "",
    ]
```

Leave `showCopy` and the meta span as they are. An empty `semifFooter` drops out of the join. A provided phrase shows whenever that text part already shows meta.

- [ ] **Step 3: Pass the turn phrase from the timeline**

In `packages/app/src/pages/session/timeline/message-timeline.tsx`, add the import next to the message-part import:

```ts
import { semifFooterForPart, semifFooterLabel } from "@opencode-ai/session-ui/semif-footer"
```

Next to `turnDurationMs`, collect the turn parts and build the phrase:

```ts
  const turnParts = (userMessageID: string) => {
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages
    return messages.flatMap((message) => getMsgParts(message.id))
  }

  const semifFooter = (userMessageID: string, partID: string) => {
    const copyPartID = assistantCopyPartID(userMessageID)
    const phrase = semifFooterLabel({
      parts: turnParts(userMessageID),
      locale: language.intl(),
      t: language.t,
      plural: language.plural,
    })
    return semifFooterForPart(copyPartID, partID, phrase)
  }
```

On the `MessagePart` in `renderAssistantPartGroup`, pass the phrase for that part:

```tsx
              <MessagePart
                part={part()}
                message={message()}
                showAssistantCopyPartID={assistantCopyPartID(row().userMessageID)}
                turnDurationMs={turnDurationMs(row().userMessageID)}
                semifFooter={semifFooter(row().userMessageID, part().id)}
                useV2Actions={settings.general.newLayoutDesigns()}
```

Do not pass `semifFooter` from any other call site. Do not render a footer when the turn has no text part.

- [ ] **Step 4: Re-run the phrase tests**

From `packages/session-ui`:

```bash
bun test --conditions=browser src/components/semif-footer.test.ts
```

Expected: PASS.

From `packages/session-ui`:

```bash
bun typecheck
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add packages/session-ui/package.json packages/session-ui/src/components/message-part.tsx packages/app/src/pages/session/timeline/message-timeline.tsx
git commit -m "feat(app): show semif use on the assistant closing line"
```
