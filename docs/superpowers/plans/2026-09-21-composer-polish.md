# Composer Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production `PromptInputV2` a compact card with a todo/revert strip, and move open permission and question requests into transcript activity rows.

**Architecture:** Polish `PromptInputV2` in place. `SessionComposerRegion` stops mounting todo, revert, permission, and question docks and passes a strip into the card. `MessageTimeline` renders the open request once, using `BasicTool`, from the same live signals the docks use today. Followup stays a dock. New-session reuses the card without a strip.

**Tech Stack:** SolidJS, Bun test, existing `IconButtonV2` / `BasicTool` / i18n.

## Global Constraints

- Baseline `origin/dev` @ `0f38503f8`. Branch `cursor/composer-polish-spec-6cba`.
- Presentation only. Do not change protocol, `SessionV2.prompt`, the permissions engine, or `createPromptSubmit` error handling.
- Do not delete `PromptInput` v1. Do not promote `BasicToolV2`. Do not switch to `cursor.json`.
- English copy only through existing i18n keys. No hardcoded JSX English.
- `IconButtonV2` takes `icon` as `JSX.Element`, not an icon-name string.
- Permission and question rows are ephemeral UI derived from the open request. Do not add durable `TimelineRow` tags or protocol fields.
- Tests run from package directories. session-ui DOM tests use `bun test --conditions=browser`.
- Typecheck with `bun typecheck` from the package directory.
- Conventional commits: `feat(session-ui): ...`, `feat(app): ...`.

**Spec:** `docs/superpowers/specs/2026-09-21-composer-polish-design.md`

## File map

| File | Role |
|---|---|
| `packages/session-ui/src/v2/components/prompt-input/index.tsx` | Compact form, `IconButtonV2` send, optional strip |
| `packages/session-ui/src/v2/components/prompt-input/prompt-input.test.tsx` | DOM contract for density, send, strip |
| `packages/app/src/components/prompt-input-v2.tsx` | Forward `strip` into `PromptInputV2` |
| `packages/app/src/pages/session/composer/session-composer-region.tsx` | Drop the four docks; keep followup |
| `packages/app/src/pages/session/composer/session-composer-strip.tsx` | Build strip label + collapsed body from todo and revert state |
| `packages/app/src/pages/session/timeline/message-timeline.tsx` | Render open permission/question as one `BasicTool` row |
| `packages/app/src/pages/session.tsx` | Pass the open requests and handlers into the timeline; pass the strip into the composer |

---

### Task 1: Compact card and v2 send button

**Files:**
- Modify: `packages/session-ui/src/v2/components/prompt-input/index.tsx`
- Test: `packages/session-ui/src/v2/components/prompt-input/prompt-input.test.tsx`

**Interfaces:**
- Consumes: existing `PromptInputV2` props and `PromptInputV2SubmitButton`.
- Produces: form without `min-h-[96px]`, toolbar without `h-11`, submit node `data-component="icon-button-v2"`.

- [ ] **Step 1: Write the failing test**

Create `packages/session-ui/src/v2/components/prompt-input/prompt-input.test.tsx`. Follow the happy-dom + `solid-js/h` React shim already used by `packages/session-ui/src/components/basic-tool.test.tsx`. Render `PromptInputV2` with a minimal controller stub whose `state.mode` is `"normal"`, `canSubmit()` is true, and `view.submit.stopping()` is false.

```ts
test("composer card is compact and send uses IconButtonV2", () => {
  const root = renderPrompt()
  const form = root.querySelector("[data-component='prompt-input-v2']")
  expect(form?.className).not.toContain("min-h-[96px]")
  const toolbar = form?.querySelector("[data-slot='prompt-toolbar']")
  expect(toolbar?.className).not.toContain("h-11")
  expect(root.querySelector("[data-action='prompt-submit']")?.getAttribute("data-component")).toBe("icon-button-v2")
})
```

- [ ] **Step 2: Run the test**

Run from `packages/session-ui`:

```bash
bun test --conditions=browser src/v2/components/prompt-input/prompt-input.test.tsx
```

Expected: FAIL because the form still has `min-h-[96px]` and the submit control is not `icon-button-v2`.

- [ ] **Step 3: Implement**

In `PromptInputV2`, remove `min-h-[96px]` from the form class. Remove `min-h-[60px]` from the editor wrapper and the contenteditable. Keep `max-h-[180px]`, `text-[13px]`, `leading-5`, `pt-4`, and `pb-2`.

Mark the toolbar:

```tsx
<div data-slot="prompt-toolbar" class="flex items-center px-2 py-1.5">
```

Replace the `IconButton` in `PromptInputV2SubmitButton` with `IconButtonV2`. Pass the sprite through `icon`:

```tsx
<IconButtonV2
  data-action="prompt-submit"
  type="button"
  disabled={!props.stopping && props.disabled}
  tabIndex={props.mode === "normal" ? undefined : -1}
  variant="contrast"
  size="small"
  icon={
    <Icon
      name={props.stopping ? "stop" : props.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
      size="small"
    />
  }
  aria-label={props.stopping ? props.stopLabel : props.sendLabel}
  onClick={() => (props.stopping ? props.onStop() : props.onSubmit())}
/>
```

Keep the existing tooltip. Drop the unused `IconButton` import when nothing else in the file references it.

- [ ] **Step 4: Re-run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-ui/src/v2/components/prompt-input/index.tsx packages/session-ui/src/v2/components/prompt-input/prompt-input.test.tsx
git commit -m "feat(session-ui): compact the composer card and send button"
```

---

### Task 2: Optional strip slot

**Files:**
- Modify: `packages/session-ui/src/v2/components/prompt-input/index.tsx`
- Modify: `packages/session-ui/src/v2/components/prompt-input/prompt-input.test.tsx`

**Interfaces:**
- Consumes: Task 1 form.
- Produces:

```ts
export type PromptInputV2Strip = {
  label: string
  expanded: boolean
  onToggle: () => void
  body?: JSX.Element
}

// added to PromptInputV2Props
strip?: PromptInputV2Strip
```

- [ ] **Step 1: Write the failing tests**

```ts
test("strip is absent when omitted", () => {
  const root = renderPrompt()
  expect(root.querySelector("[data-slot='prompt-strip']")).toBeNull()
})

test("strip shows the label and hides the body until expanded", () => {
  const root = renderPrompt({
    strip: { label: "1 of 3 todos completed", expanded: false, onToggle() {}, body: <div data-slot="strip-body" /> },
  })
  expect(root.querySelector("[data-slot='prompt-strip']")?.textContent).toContain("1 of 3 todos completed")
  expect(root.querySelector("[data-slot='strip-body']")).toBeNull()
})
```

- [ ] **Step 2: Run the tests**

Same command as Task 1. Expected: FAIL, `prompt-strip` missing.

- [ ] **Step 3: Implement**

Add `strip` to `PromptInputV2Props`. Inside the form, before the attachments block:

```tsx
<Show when={props.strip}>
  {(strip) => (
    <div data-slot="prompt-strip">
      <button type="button" data-slot="prompt-strip-toggle" onClick={() => strip().onToggle()}>
        {strip().label}
      </button>
      <Show when={strip().expanded}>{strip().body}</Show>
    </div>
  )}
</Show>
```

Style the toggle as one muted line (`text-[12px]`, `text-v2-text-text-muted`, horizontal padding matching the editor). Do not give the strip a dock border or overlap margin.

- [ ] **Step 4: Re-run the tests**

Expected: PASS, including Task 1.

- [ ] **Step 5: Commit**

```bash
git add packages/session-ui/src/v2/components/prompt-input/index.tsx packages/session-ui/src/v2/components/prompt-input/prompt-input.test.tsx
git commit -m "feat(session-ui): add a collapsed composer strip slot"
```

---

### Task 3: Session strip replaces todo and revert docks

**Files:**
- Create: `packages/app/src/pages/session/composer/session-composer-strip.tsx`
- Modify: `packages/app/src/components/prompt-input-v2.tsx`
- Modify: `packages/app/src/pages/session/composer/session-composer-region.tsx`
- Modify: `packages/app/src/pages/session.tsx` (pass `strip` into `PromptInputV2Composer`)
- Test: `packages/app/src/pages/session/composer/session-composer-strip.test.ts`

**Interfaces:**
- Consumes: `PromptInputV2Strip` from Task 2. Existing `session.todo.progress` and `session.revertDock.summary` keys. Existing `SessionTodoDock` list body and `SessionRevertDock` list body, rendered as `strip.body` without their dock chrome.
- Produces: `composerStrip(input): PromptInputV2Strip | undefined`.

```ts
export function composerStrip(input: {
  todos: readonly { status: string }[]
  revertCount: number
  expanded: boolean
  onToggle: () => void
  body?: JSX.Element
  todoLabel: (done: number, total: number) => string
  revertLabel: (count: number) => string
}): PromptInputV2Strip | undefined
```

Label rules: no todos and `revertCount === 0` returns `undefined`. Todos only: `todoLabel(done, total)`. Revert only: `revertLabel(count)`. Both: `${todoLabel(done, total)} · ${revertLabel(count)}`. `done` counts todos whose `status === "completed"`.

- [ ] **Step 1: Write the failing test**

`session-composer-strip.test.ts` is a pure function test (no DOM):

```ts
test("omits the strip when nothing is pending", () => {
  expect(composerStrip({ todos: [], revertCount: 0, expanded: false, onToggle() {}, todoLabel: () => "", revertLabel: () => "" })).toBeUndefined()
})

test("joins todo progress and revert summary", () => {
  const strip = composerStrip({
    todos: [{ status: "completed" }, { status: "pending" }],
    revertCount: 2,
    expanded: false,
    onToggle() {},
    todoLabel: (done, total) => `${done} of ${total} todos completed`,
    revertLabel: (count) => `${count} rolled back messages`,
  })
  expect(strip?.label).toBe("1 of 2 todos completed · 2 rolled back messages")
})
```

- [ ] **Step 2: Run it**

From `packages/app`:

```bash
bun test --conditions=solid src/pages/session/composer/session-composer-strip.test.ts
```

Expected: FAIL, `composerStrip` is not defined.

- [ ] **Step 3: Implement and wire**

Implement `composerStrip` as specified.

`PromptInputV2Composer` accepts optional `strip` and forwards it to `PromptInputV2`.

In `session.tsx`, where `PromptInputV2Composer` is created, pass `strip={composerStrip(...)}` using `language.t("session.todo.progress", { done, total })` and `language.plural("session.revertDock.summary", count)`. The body is the existing todo and revert lists only when `expanded` is true; the strip component still receives `body` so the card can show it. Default `expanded` to false in a local signal.

In `session-composer-region.tsx`, delete the `SessionTodoDock` and `SessionRevertDock` mounts and delete the `margin-top: -36 * dockProgress` / `lift()` styles. Keep `SessionFollowupDock` immediately above `promptInput`, with no negative margin. Delete the question and permission `Show` blocks in Task 4, not here, so this task still compiles while those docks remain until the timeline owns them.

- [ ] **Step 4: Re-run the strip test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/composer/session-composer-strip.tsx packages/app/src/pages/session/composer/session-composer-strip.test.ts packages/app/src/components/prompt-input-v2.tsx packages/app/src/pages/session/composer/session-composer-region.tsx packages/app/src/pages/session.tsx
git commit -m "feat(app): move todos and revert into the composer strip"
```

---

### Task 4: Permission and question activity rows

**Files:**
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx`
- Modify: `packages/app/src/pages/session/composer/session-composer-region.tsx`
- Modify: `packages/app/src/pages/session/composer/session-permission-dock.tsx`
- Modify: `packages/app/src/pages/session/composer/session-question-dock.tsx`
- Modify: `packages/app/src/pages/session.tsx`
- Test: `packages/app/src/pages/session/timeline/request-row.test.ts`

**Interfaces:**
- Consumes: `BasicTool` from `@opencode-ai/session-ui/message-part`. Existing dock bodies and handlers.
- Produces: `MessageTimeline` props:

```ts
requests?: {
  permission?: {
    title: string
    target: string
    body: JSX.Element
  }
  question?: {
    title: string
    target: string
    body: JSX.Element
  }
}
```

`requestRowLabel` is not required. The test locks the pure visibility helper:

```ts
export function openRequestKinds(input: { permission: boolean; question: boolean }) {
  return [
    input.permission ? "permission" : undefined,
    input.question ? "question" : undefined,
  ].filter((kind): kind is "permission" | "question" => kind !== undefined)
}
```

- [ ] **Step 1: Write the failing test**

```ts
test("lists an open permission and question once", () => {
  expect(openRequestKinds({ permission: true, question: false })).toEqual(["permission"])
  expect(openRequestKinds({ permission: false, question: false })).toEqual([])
  expect(openRequestKinds({ permission: true, question: true })).toEqual(["permission", "question"])
})
```

- [ ] **Step 2: Run it**

From `packages/app`:

```bash
bun test --conditions=solid src/pages/session/timeline/request-row.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Add `openRequestKinds` next to the timeline module and use it only as the decision for which rows to mount. In `MessageTimeline`, after the virtualized turn content and inside the scroll content, render one `BasicTool` per open kind:

```tsx
<Show when={props.requests?.permission}>
  {(request) => (
    <BasicTool
      icon="warning"
      status="running"
      allowOpenWhilePending
      trigger={{ title: request().title, subtitle: request().target }}
    >
      {request().body}
    </BasicTool>
  )}
</Show>
```

Same shape for question with `icon="question"`. Collapsed by default (`BasicTool` already defaults closed).

`session.tsx` passes `requests` from `controller.state.permissionRequest()` and `questionRequest()`. `title` is `language.t("notification.permission.title")` or the existing question title key already used by `SessionQuestionDock`. `target` is `request.patterns.join(", ")` for permission, and the question prompt text for question. `body` is `SessionPermissionDock` / `SessionQuestionDock`.

Remove the `DockPrompt` wrapper from both dock components so the activity row is the only chrome. Keep `onDecide` and `onSubmit`.

Delete the permission and question `Show` blocks from `session-composer-region.tsx`.

Do not add a `TimelineRow` tag. When the request accessor returns undefined, the row unmounts.

If `message-part` already renders a pending `question` tool for the same open request, skip that part while `requests.question` is set. Gate it in the timeline's part renderer with the existing question-part pending check (`part.tool === "question"` and status `pending` or `running`).

- [ ] **Step 4: Re-run the test and typecheck**

```bash
bun test --conditions=solid src/pages/session/timeline/request-row.test.ts
bun typecheck
```

Expected: test PASS. Typecheck may still fail on pre-existing duplicate i18n keys in locale files; do not edit those locales in this task. `packages/session-ui` `bun typecheck` must pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/timeline/message-timeline.tsx packages/app/src/pages/session/timeline/request-row.test.ts packages/app/src/pages/session/composer/session-composer-region.tsx packages/app/src/pages/session/composer/session-permission-dock.tsx packages/app/src/pages/session/composer/session-question-dock.tsx packages/app/src/pages/session.tsx
git commit -m "feat(app): show open permission and question as activity rows"
```

---

### Task 5: New-session uses the compact card without a strip

**Files:**
- Modify: `packages/app/src/pages/new-session/new-session-view.tsx` only if it passes a strip; otherwise no code change
- Test: `packages/app/src/pages/new-session/new-session-view.test.ts` if a render test already exists; otherwise assert in `prompt-input-v2` that the composer omits `strip` unless the caller sets it

**Interfaces:**
- Consumes: Task 2 `strip?`.
- Produces: new-session hero unchanged and `PromptInputV2Composer` called without `strip`.

- [ ] **Step 1: Confirm the call site**

`new-session-view.tsx` renders `<PromptInputV2Composer controller={props.input} />` and must not gain a `strip` prop. Do not edit the hero markup.

- [ ] **Step 2: Add a regression assertion**

In `packages/app/src/components/prompt-input-v2.tsx`, the composer forwards `props.strip` only. A unit test is unnecessary if Task 2 already proves an omitted strip renders nothing. Add one sentence to the new-session file only when a future edit starts passing `strip`.

- [ ] **Step 3: Run session-ui and the app strip/request tests**

```bash
cd packages/session-ui && bun test --conditions=browser src/v2/components/prompt-input/prompt-input.test.tsx
cd packages/app && bun test --conditions=solid src/pages/session/composer/session-composer-strip.test.ts src/pages/session/timeline/request-row.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit only if a file changed**

```bash
git commit -m "test(app): keep the new-session composer free of the session strip"
```

Skip the commit when this task changes no files.
