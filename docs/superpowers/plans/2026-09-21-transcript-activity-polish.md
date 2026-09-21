# Transcript Activity Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live transcript scan as a Cursor-like stack of one-line activity rows (icon + verb + target), all collapsed, with reasoning behind Thinking/Thought and no “Gathering context” group.

**Architecture:** Polish production `BasicTool` so it actually paints the sprite `icon` and uses one-line trigger anatomy. Ungroup `read`/`glob`/`grep`/`list` in `groupParts`. Convert thinking from a free-standing `reasoning-part` (plus a footer shimmer) into the same collapsible row, shared by `SessionTurn` and `TimelineThinkingRow`. Presentation-only: part status, protocol, and runner stay unchanged.

**Tech Stack:** SolidJS, existing `@opencode-ai/ui` `Collapsible` / `Icon` / `TextShimmer`, i18n English source in `packages/ui/src/i18n/en.ts`, Bun tests from `packages/session-ui` (and `packages/app` only where timeline projection / e2e locators would otherwise go red).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-21-transcript-activity-polish-design.md`
- Baseline: `origin/dev` @ `6936ab116`
- Presentation-only. Do not add protocol fields, touch Session V2 execution, or import Core from Client.
- Do not migrate to `BasicToolV2`, Lucide, Phosphor, or `cursor.json`.
- Do not extract a new `ActivityRow` type. Keep logic in the existing components.
- No `any`. When touching `isTriggerTitle`, use `unknown` like `basic-tool-v2.tsx`.
- English user-visible verbs live in `packages/ui/src/i18n/en.ts`. Never hardcode JSX English. Do not machine-translate the 60 other locale files; `language.tsx` merges locale dicts on top of English (`{ ...base, ...locale }`), so missing keys fall back.
- Keep Inter (UI) and JetBrains Mono (code/shell). Tighten weight/size/gap on the activity row only.
- All tools default collapsed, including shell. `allowOpenWhilePending` stays on shell only. Thinking may expand while streaming so the user can read reasoning; it still defaults closed.
- Consecutive edits to the same file stay grouped (`EditToolGroup`). Only context grouping is removed.
- `todowrite` stays hidden.
- Tests run from package directories, never repo root. Typecheck with `bun typecheck` from the package directory.
- No screenshot-gated CI. No `packages/core` tests.
- Conventional commits: `feat(session-ui): ...` / `fix(app): ...` / `test(session-ui): ...` / `docs: ...`.
- Branch: `cursor/transcript-activity-plan-6cba`.

## File map

| File | Role |
|---|---|
| `packages/ui/src/i18n/en.ts` | Add `ui.sessionTurn.status.thought` (`Thought`) and `ui.tool.shell.ran` (`Ran`) |
| `packages/session-ui/src/components/basic-tool.tsx` | Paint sprite icon; chevron first; `unknown` guard |
| `packages/session-ui/src/components/basic-tool.css` | Row density (13px, 6px gap); icon slot color |
| `packages/session-ui/happydom.ts` + `bunfig.toml` | DOM for Solid component tests |
| `packages/session-ui/src/components/basic-tool.test.tsx` | Icon node is present when `icon` is set |
| `packages/session-ui/src/components/message-part-groups.ts` | Stop collapsing read/glob/grep/list |
| `packages/session-ui/src/components/message-part-groups.test.ts` | Each context tool is its own `part` group |
| `packages/session-ui/src/components/message-part.tsx` | Delete `ContextToolGroup`; shell `Ran`; edit/write one-line; reasoning uses `BasicTool` |
| `packages/session-ui/src/components/message-part.css` | Remove context-group chrome |
| `packages/session-ui/src/components/part-default-open.ts` | Shell stays closed unless caller passes `shell === true` |
| `packages/session-ui/src/components/part-default-open.test.ts` | Default shell closed |
| `packages/session-ui/src/components/thinking-status.tsx` | Same row anatomy; title Thinking/Thought; optional children = reasoning |
| `packages/session-ui/src/components/tool-error-card.tsx` | Chevron first; verb + target + error subtitle |
| `packages/session-ui/src/components/session-turn.tsx` | Thinking placeholder only while working with no reasoning part yet |
| `packages/app/src/pages/session/timeline/message-timeline.tsx` | Drop `ContextToolGroup` branch; `TimelineThinkingRow` uses `ThinkingStatus` |
| `packages/app/src/pages/session/timeline/rows.ts` | Thinking footer only when busy and no renderable reasoning part |
| `packages/app/e2e/regression/session-timeline-context-resize.spec.ts` | Assert individual tool part ids, not `data-timeline-part-ids` |
| `packages/app/e2e/regression/session-timeline-reasoning-projection.spec.ts` | Reasoning lives inside the thinking collapsible, not a sibling `reasoning-part` |

Do not edit: `packages/session-ui/src/v2/components/basic-tool-v2.tsx`, protocol/runner, Linux/Tauri packaging, prompt/sidebar/chrome.

---

### Task 1: English copy keys

**Files:**
- Modify: `packages/ui/src/i18n/en.ts`
- Test: `packages/session-ui/src/components/shell-command-summary.test.ts` (already imports `dict as en`; extend with two key assertions)

**Interfaces:**
- Consumes: existing `ui.sessionTurn.status.thinking` = `Thinking`, `ui.tool.shell` = `Shell`.
- Produces: `ui.sessionTurn.status.thought` = `Thought`; `ui.tool.shell.ran` = `Ran`. Locale files other than `en.ts` are unchanged (English fallback).

- [ ] **Step 1: Write the failing key assertions**

Add to the bottom of `packages/session-ui/src/components/shell-command-summary.test.ts`:

```ts
test("transcript activity verbs exist in English source", () => {
  expect(en["ui.sessionTurn.status.thinking"]).toBe("Thinking")
  expect(en["ui.sessionTurn.status.thought"]).toBe("Thought")
  expect(en["ui.tool.shell.ran"]).toBe("Ran")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/shell-command-summary.test.ts` from `packages/session-ui`

Expected: FAIL — `en["ui.sessionTurn.status.thought"]` is `undefined`.

- [ ] **Step 3: Add the keys next to the existing thinking/shell entries**

In `packages/ui/src/i18n/en.ts`, immediately after `"ui.sessionTurn.status.thinking": "Thinking"`:

```ts
  "ui.sessionTurn.status.thought": "Thought",
```

Immediately after `"ui.tool.shell": "Shell"`:

```ts
  "ui.tool.shell.ran": "Ran",
```

Do not add keys to `br.ts` or other locales. Do not change `ui.tool.shell` from `Shell` (error-card fallback and generic title still use it).

- [ ] **Step 4: Re-run test**

Run: `bun test src/components/shell-command-summary.test.ts` from `packages/session-ui`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/i18n/en.ts packages/session-ui/src/components/shell-command-summary.test.ts
git commit -m "feat(session-ui): add Thought and Ran activity verbs"
```

---

### Task 2: BasicTool paints the sprite icon

**Files:**
- Create: `packages/session-ui/happydom.ts`
- Create: `packages/session-ui/bunfig.toml`
- Create: `packages/session-ui/src/components/basic-tool.test.tsx`
- Modify: `packages/session-ui/package.json` (devDependency `@happy-dom/global-registrator`)
- Modify: `packages/session-ui/src/components/basic-tool.tsx`
- Modify: `packages/session-ui/src/components/basic-tool.css`

**Interfaces:**
- Consumes: `BasicToolProps.icon: IconProps["name"]`; existing `Collapsible.Arrow` hover/rotate CSS.
- Produces: trigger DOM order = chevron, then `[data-slot="basic-tool-tool-icon"]` with `<Icon name={props.icon} size="small" />`, then title/subtitle/args. Structured `TriggerTitle` and custom JSX both see the icon node so the spec test holds.

- [ ] **Step 1: Add happy-dom preload (required before the component test can query the DOM)**

Create `packages/session-ui/happydom.ts`:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
```

Create `packages/session-ui/bunfig.toml` (same shape as `packages/app/bunfig.toml`; preload is relative to this file):

```toml
[test]
root = "./src"
preload = ["./happydom.ts"]
```

Add to `packages/session-ui/package.json` `devDependencies` (same version as `packages/app`):

```json
"@happy-dom/global-registrator": "20.12.0"
```

Run `bun install` from `packages/session-ui`.

- [ ] **Step 2: Write the failing icon test**

Create `packages/session-ui/src/components/basic-tool.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { BasicTool } from "./basic-tool"

describe("BasicTool", () => {
  test("trigger contains the icon node when icon is set", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => <BasicTool icon="glasses" trigger={{ title: "Read", subtitle: "foo.ts" }} />,
      host,
    )
    const icon = host.querySelector('[data-slot="basic-tool-tool-icon"]')
    expect(icon).toBeTruthy()
    expect(host.querySelector("use")?.getAttribute("href")).toBe("#opencode-icon-glasses")
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toContain("Read")
    dispose()
    host.remove()
  })
})
```

The title `"Read"` here is test fixture text, not production copy.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/components/basic-tool.test.tsx` from `packages/session-ui`

Expected: FAIL — `querySelector('[data-slot="basic-tool-tool-icon"]')` is `null` (`BasicTool` accepts `icon` and never renders it).

- [ ] **Step 4: Render the icon, put the chevron first, drop `any`**

In `packages/session-ui/src/components/basic-tool.tsx`:

1. Import `Icon`:

```ts
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
```

Remove the separate `import type { IconProps }` line.

2. Replace `isTriggerTitle`:

```ts
const isTriggerTitle = (val: unknown): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}
```

3. Inside `trigger()`, put `Collapsible.Arrow` first (still gated by `hasChildren() && !props.hideDetails && !props.locked && (!pending() || props.allowOpenWhilePending)`). Then `basic-tool-tool-trigger-content`. First child of that content slot:

```tsx
<span data-slot="basic-tool-tool-icon">
  <Icon name={props.icon} size="small" />
</span>
```

Keep the existing `Switch` for structured vs custom trigger after the icon.

- [ ] **Step 5: Tighten row CSS only**

In `packages/session-ui/src/components/basic-tool.css`, inside `[data-component="tool-trigger"]`:

- `[data-slot="basic-tool-tool-trigger-content"]` `gap: 6px`
- `[data-slot="basic-tool-tool-info-structured"]` `gap: 6px`
- `[data-slot="basic-tool-tool-info-main"]` `gap: 6px` and `align-items: center`
- `[data-slot="basic-tool-tool-title"]` and subtitle/arg: `font-size: 13px`, `line-height: 20px`
- Add:

```css
  [data-slot="basic-tool-tool-icon"] {
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--v2-icon-icon-muted, var(--icon-weak, currentColor));
  }
```

Do not change `[data-component="task-tool-card"]` rules. Do not change font-family (keep `var(--font-family-sans)`).

- [ ] **Step 6: Re-run test**

Run: `bun test src/components/basic-tool.test.tsx` from `packages/session-ui`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/session-ui/happydom.ts packages/session-ui/bunfig.toml packages/session-ui/package.json packages/session-ui/src/components/basic-tool.tsx packages/session-ui/src/components/basic-tool.css packages/session-ui/src/components/basic-tool.test.tsx
git commit -m "feat(session-ui): render BasicTool sprite icons on activity rows"
```

---

### Task 3: Ungroup read / glob / grep / list

**Files:**
- Modify: `packages/session-ui/src/components/message-part-groups.ts`
- Modify: `packages/session-ui/src/components/message-part-groups.test.ts`
- Modify: `packages/session-ui/src/components/message-part.tsx`
- Modify: `packages/session-ui/src/components/message-part.css`
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx`

**Interfaces:**
- Consumes: `groupParts(parts): PartGroup[]`. `PartGroup` currently includes `type: "context"`.
- Produces: consecutive read/glob/grep/list become `type: "part"` groups (one row each). `type: "context"` is removed from `PartGroup`. `EditToolGroup` is unchanged. `ContextToolGroup` and `isContextGroupTool` are deleted.

- [ ] **Step 1: Write the failing grouping test**

Replace the existing `"keeps grouping context tools"` test in `packages/session-ui/src/components/message-part-groups.test.ts` with:

```ts
  test("does not group consecutive read grep list glob tools", () => {
    const groups = groupParts([
      { messageID: "message", part: toolPart("read", "part_0") },
      { messageID: "message", part: toolPart("grep", "part_1") },
      { messageID: "message", part: toolPart("list", "part_2") },
      { messageID: "message", part: toolPart("glob", "part_3") },
      { messageID: "message", part: editPart("part_4", "src/dv.ts") },
      { messageID: "message", part: editPart("part_5", "src/dv.ts") },
    ])

    expect(groups.map((group) => group.type)).toEqual(["part", "part", "part", "part", "edit"])
    expect(groups.slice(0, 4).map((group) => (group.type === "part" ? group.ref.partID : ""))).toEqual([
      "part_0",
      "part_1",
      "part_2",
      "part_3",
    ])
  })
```

Keep the six consecutive-edit tests as they are.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/message-part-groups.test.ts` from `packages/session-ui`

Expected: FAIL — actual types are `["context", "edit"]`.

- [ ] **Step 3: Stop emitting context groups**

In `packages/session-ui/src/components/message-part-groups.ts`:

- Delete `CONTEXT_GROUP_TOOLS`, `isContextGroupTool`, and the `type: "context"` arm of `PartGroup`.
- Delete `contextStart` and the context branch inside `flush` / `forEach`. Context tools fall through to the generic `type: "part"` push (same as grep used to after a non-context tool).
- Keep `isEditTool`, `editFilePath`, and edit collapsing.

`PartGroup` becomes:

```ts
export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "edit"
      refs: PartRef[]
    }
```

- [ ] **Step 4: Delete ContextToolGroup and its call sites**

In `packages/session-ui/src/components/message-part.tsx`:

- Remove `isContextGroupTool` from the import and from `export { groupParts, isContextGroupTool, sameGroups }`. Export becomes `export { groupParts, sameGroups } from "./message-part-groups"`.
- In `AssistantParts` and `AssistantMessageDisplay`, delete the `<Match when={entryType() === "context"}>` blocks.
- Delete `contextToolDetail`, `contextToolTrigger`, `contextToolSummary`, and `export function ContextToolGroup`.
- Leave `EditToolGroup` in place.

In `packages/session-ui/src/components/message-part.css`, delete `[data-component="context-tool-group-trigger"]` and `[data-component="context-tool-group-list"]` rules.

In `packages/app/src/pages/session/timeline/message-timeline.tsx`:

- Drop `ContextToolGroup` from the `@opencode-ai/session-ui/message-part` import.
- Delete the `if (row().group.type === "context") { ... }` branch in `renderAssistantPartGroup`. The `edit` and `part` branches stay.

`ui.sessionTurn.status.gatheringContext` / `gatheredContext` keys stay in i18n (unused is fine; do not invent replacements).

- [ ] **Step 5: Re-run grouping tests**

Run: `bun test src/components/message-part-groups.test.ts` from `packages/session-ui`

Expected: PASS.

- [ ] **Step 6: Typecheck both packages**

Run: `bun typecheck` from `packages/session-ui`

Run: `bun typecheck` from `packages/app`

Expected: PASS. If `ContextToolGroup` or `isContextGroupTool` is still imported, the app typecheck fails — delete that import.

- [ ] **Step 7: Commit**

```bash
git add packages/session-ui/src/components/message-part-groups.ts packages/session-ui/src/components/message-part-groups.test.ts packages/session-ui/src/components/message-part.tsx packages/session-ui/src/components/message-part.css packages/app/src/pages/session/timeline/message-timeline.tsx
git commit -m "feat(session-ui): ungroup context tools into one activity row each"
```

---

### Task 4: Shell and edit default closed

**Files:**
- Modify: `packages/session-ui/src/components/part-default-open.test.ts`
- Modify: `packages/session-ui/src/components/timeline-playground.stories.tsx` (story override only)

**Interfaces:**
- Consumes: `partDefaultOpen(part, shell = false, edit = false)`. Settings already default `shellToolPartsExpanded: false` and `editToolPartsExpanded: false` in `packages/app/src/context/settings.tsx`.
- Produces: default (no override) is closed for shell and edit. Passing `shell === true` still opens shell (existing settings toggle). No new forced-open.

- [ ] **Step 1: Write the failing default-closed tests**

In `packages/session-ui/src/components/part-default-open.test.ts`, keep the edit-when-enabled cases. Replace `"preserves shell defaults"` and add:

```ts
  test("shell is closed by default", () => {
    expect(partDefaultOpen(tool("shell", {}))).toBe(false)
    expect(partDefaultOpen(tool("bash", {}))).toBe(false)
  })

  test("shell opens only when the caller opts in", () => {
    expect(partDefaultOpen(tool("shell", {}), true, false)).toBe(true)
  })

  test("edit stays closed by default", () => {
    expect(partDefaultOpen(tool("edit", { filediff: { additions: 1, deletions: 1 } }))).toBe(undefined)
  })
```

`partDefaultOpen` currently returns `undefined` for non-shell/non-edit and `false` for edit when `edit` is false (`if (!edit) return false`). The edit-default test should match the actual return: `false` when the part is an edit tool. Use:

```ts
  test("edit stays closed by default", () => {
    expect(partDefaultOpen(tool("edit", { filediff: { additions: 1, deletions: 1 } }))).toBe(false)
  })
```

- [ ] **Step 2: Run tests**

Run: `bun test src/components/part-default-open.test.ts` from `packages/session-ui`

Expected: the new default-closed tests PASS already (`shell = false` is the default argument). If `"preserves shell defaults"` was `expect(..., true, false).toBe(true)` it still passes. No production change required unless a test still encodes default-open.

If the old test name `"preserves shell defaults"` remains and still expects `true` when `shell=true`, leave that as the opt-in test (or replace it with the opt-in test above).

- [ ] **Step 3: Align the playground with production**

In `packages/session-ui/src/components/timeline-playground.stories.tsx`, change `shellToolDefaultOpen={true}` to `shellToolDefaultOpen={false}`.

- [ ] **Step 4: Re-run tests**

Run: `bun test src/components/part-default-open.test.ts` from `packages/session-ui`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-ui/src/components/part-default-open.test.ts packages/session-ui/src/components/timeline-playground.stories.tsx
git commit -m "test(session-ui): lock shell and edit activity rows closed by default"
```

---

### Task 5: Shell verb is Ran

**Files:**
- Modify: `packages/session-ui/src/components/message-part.tsx` (`ToolRegistry.register` for `"shell"` and `getToolInfo` bash/shell)

**Interfaces:**
- Consumes: `ui.tool.shell.ran` from Task 1; `summarizeShellCommand(command)` still returns `{ key, target?, params? }`.
- Produces: collapsed row title `Ran`; subtitle = `summary.target` if present, otherwise the raw command (CSS ellipsis truncates). Expanded body stays `$ cmd` + output. `allowOpenWhilePending` stays. Drop the custom trigger that painted its own `console` icon (Task 2 already paints `props.icon`).

- [ ] **Step 1: Assert getToolInfo shell verb (failing until implementation)**

Add to `packages/session-ui/src/components/shell-command-summary.test.ts` (this file already imports `en`; do not render Solid here):

```ts
test("English Ran verb is the shell activity title", () => {
  expect(en["ui.tool.shell.ran"]).toBe("Ran")
  expect(en["ui.tool.shell.ran"]).not.toBe(en["ui.tool.shell"])
})
```

This should already pass after Task 1. Keep it as a regression lock, then change production.

- [ ] **Step 2: Change getToolInfo and the shell registry**

In `getToolInfo` for `case "bash": case "shell":`:

```ts
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell.ran"),
        subtitle: input.command,
      }
```

Replace the shell `render` trigger with a structured `TriggerTitle` (no custom icon span, no `shell-tool-action` weight override as the title):

```tsx
    const target = createMemo(() => summary()?.target ?? command())
    // ...
      <BasicTool
        {...props}
        icon="console"
        allowOpenWhilePending
        trigger={{
          title: i18n.t("ui.tool.shell.ran"),
          subtitle: target(),
        }}
      >
```

Delete the `trigger={(open) => (...)}` function, `ShellSubmessage` usage in this register, and the `label()` memo that translated `ui.tool.shell.action.*` into the title. Keep `summarizeShellCommand` so the subtitle can show the extracted path; keep the expanded `bash-output` body and copy control unchanged.

`TextShimmer` still wraps the title inside `BasicTool` when `status` is pending/running — do not add a second shimmer.

- [ ] **Step 3: Run session-ui tests**

Run: `bun test src/components/shell-command-summary.test.ts src/components/basic-tool.test.tsx` from `packages/session-ui`

Expected: PASS. `summarizeShellCommand` cases still return the same action keys (helper unchanged).

- [ ] **Step 4: Typecheck**

Run: `bun typecheck` from `packages/session-ui`

Expected: PASS. If `label` / `ShellSubmessage` become unused in the shell register, delete those locals. If `ShellSubmessage` is unused elsewhere in the file, delete the function too.

- [ ] **Step 5: Commit**

```bash
git add packages/session-ui/src/components/message-part.tsx packages/session-ui/src/components/shell-command-summary.test.ts
git commit -m "feat(session-ui): show Ran plus target on collapsed shell rows"
```

---

### Task 6: Edit and write use the one-line row contract

**Files:**
- Modify: `packages/session-ui/src/components/message-part.tsx` (`ToolRegistry.register` for `"edit"` and `"write"`)

**Interfaces:**
- Consumes: `BasicTool` structured trigger from Task 2; existing `DiffChanges` for `+n -n`; `ui.messagePart.title.edit` / `ui.messagePart.title.write`.
- Produces: edit trigger `{ title, subtitle: filename, action: <DiffChanges /> }`. Write trigger `{ title, subtitle: filename }`. Diff / file accordion stay in the collapsed body. Do not restyle `EditToolGroup`.

- [ ] **Step 1: Replace the edit custom trigger**

In the `"edit"` register, replace the `trigger={ <div data-component="edit-trigger"> ... }` JSX with:

```tsx
        trigger={{
          title: i18n.t("ui.messagePart.title.edit"),
          subtitle: filename(),
          action: !pending() && props.metadata.filediff ? <DiffChanges changes={props.metadata.filediff} /> : undefined,
        }}
```

Keep `icon="code-lines"`, `defer={props.deferContent !== false}`, and the children (`ToolFileAccordion` + diagnostics).

- [ ] **Step 2: Replace the write custom trigger**

```tsx
        trigger={{
          title: i18n.t("ui.messagePart.title.write"),
          subtitle: filename(),
        }}
```

Patch / apply_patch already use structured `{ title, subtitle }` — leave them.

- [ ] **Step 3: Typecheck**

Run: `bun typecheck` from `packages/session-ui`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/session-ui/src/components/message-part.tsx
git commit -m "feat(session-ui): put edit and write on one activity line"
```

---

### Task 7: ToolErrorCard matches the activity row

**Files:**
- Modify: `packages/session-ui/src/components/tool-error-card.tsx`
- Modify: `packages/session-ui/src/components/message-part.tsx` (error `Match` in `ToolPartDisplay`)
- Create: `packages/session-ui/src/components/tool-error-card.test.tsx`

**Interfaces:**
- Consumes: existing `ToolErrorCardProps` (`tool`, `error`, `title?`, `subtitle?`). Failure icon is already `circle-ban-sign`.
- Produces: chevron first (same as Task 2); trigger contains `[data-slot="basic-tool-tool-icon"]`, title (verb), subtitle (target or existing short error / `ui.toolErrorCard.failed`). Body remains message + copy. No second success row under the error card.

- [ ] **Step 1: Write the failing error-row test**

Create `packages/session-ui/src/components/tool-error-card.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { ToolErrorCard } from "./tool-error-card"

const i18n: UiI18n = {
  locale: () => "en",
  t: (key) => en[key] ?? key,
  plural: (key, count) => (en[`${key}.other`] ?? key).replaceAll("{{count}}", String(count)),
}

describe("ToolErrorCard", () => {
  test("trigger uses icon title and subtitle slots", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <I18nProvider value={i18n}>
          <ToolErrorCard tool="read" error="Error: ENOENT: no such file" subtitle="secret.ts" />
        </I18nProvider>
      ),
      host,
    )
    const trigger = host.querySelector('[data-component="tool-trigger"]')
    expect(trigger?.querySelector('[data-slot="basic-tool-tool-icon"]')).toBeTruthy()
    expect(trigger?.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toContain("Read")
    expect(trigger?.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent).toContain("secret.ts")
    dispose()
    host.remove()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/tool-error-card.test.tsx` from `packages/session-ui`

Expected: FAIL or incomplete anatomy — chevron is after the title, icon slot is `basic-tool-tool-indicator` only. After Step 3 the test must find icon + title + subtitle.

- [ ] **Step 3: Match BasicTool trigger order**

In `tool-error-card.tsx`, inside `Collapsible.Trigger` / `[data-component="tool-trigger"]`:

1. Render `Collapsible.Arrow` first.
2. Keep the icon span; add `data-slot="basic-tool-tool-icon"` on it (may coexist with `data-slot="basic-tool-tool-indicator"`).
3. Title = verb (`name()`).
4. Subtitle = `split.subtitle` when provided, otherwise the existing error-derived `subtitle()` memo.

In `ToolPartDisplay` error `Match`, pass target into `subtitle` for non-task tools:

```tsx
                  subtitle={
                    taskSubtitle() ??
                    getToolInfo(part().tool, input(), partMetadata()).subtitle
                  }
```

`getToolInfo` is already in this file. Task rows keep `taskSubtitle()` (description / session id). Do not stack a success `BasicTool` under the card — the existing `Switch` already has a single `Match` for error.

- [ ] **Step 4: Re-run test**

Run: `bun test src/components/tool-error-card.test.tsx` from `packages/session-ui`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-ui/src/components/tool-error-card.tsx packages/session-ui/src/components/tool-error-card.test.tsx packages/session-ui/src/components/message-part.tsx
git commit -m "feat(session-ui): align tool error rows with activity anatomy"
```

---

### Task 8: Thinking line owns reasoning

**Files:**
- Modify: `packages/session-ui/src/components/thinking-status.tsx`
- Modify: `packages/session-ui/src/components/thinking-status.css` (only if the row needs the same 13px/6px density)
- Modify: `packages/session-ui/src/components/message-part.tsx` (`renderable`, `PART_MAPPING["reasoning"]`)
- Modify: `packages/session-ui/src/components/session-turn.tsx`
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx` (`TimelineThinkingRow`)
- Modify: `packages/app/src/pages/session/timeline/rows.ts`
- Create: `packages/session-ui/src/components/thinking-status.test.tsx`
- Modify: `packages/session-ui/src/components/message-part.test.ts` (renderable reasoning)

**Interfaces:**
- Consumes: `ui.sessionTurn.status.thinking`, `ui.sessionTurn.status.thought`; sprite icon `brain`; `PacedMarkdown` (already used by `ReasoningPartDisplay`); `ThinkingStatus` props `active`, `pendingMessage`, `parts`.
- Produces: `ThinkingStatus` is a `BasicTool` row (`icon="brain"`, default closed, `allowOpenWhilePending` so streaming reasoning is readable). Title is `Thinking` while `active`, `Thought` otherwise. Trailing meta keeps existing elapsed / tokens / decisions. `children` is the reasoning markdown. `PART_MAPPING["reasoning"]` renders `ThinkingStatus` with that markdown as children — not a sibling `[data-component="reasoning-part"]` block. `renderable(reasoning)` is true when text is non-empty (the row is the chrome; `showReasoningSummaries` no longer spawns a free-standing unmuted block). Footer/timeline `Thinking` tag is only a placeholder while the turn is busy and no reasoning part exists yet.

- [ ] **Step 1: Write the failing thinking tests**

Add to `packages/session-ui/src/components/message-part.test.ts`:

```ts
import type { Part } from "@opencode-ai/sdk/v2"
import { renderable } from "./message-part"

function reasoningPart(id: string, text: string): Part {
  return {
    id,
    sessionID: "session",
    messageID: "message",
    type: "reasoning",
    text,
    time: { start: 0 },
  }
}

test("renderable reasoning stays a row even when summaries are off", () => {
  expect(renderable(reasoningPart("prt_1", "need to inspect foo"), false)).toBe(true)
  expect(renderable(reasoningPart("prt_2", "   "), true)).toBe(false)
})
```

Keep the existing `readPartText` tests in the same file.

Create `packages/session-ui/src/components/thinking-status.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { ThinkingStatus } from "./thinking-status"

const i18n: UiI18n = {
  locale: () => "en",
  t: (key) => en[key] ?? key,
  plural: (key, count) => (en[`${key}.other`] ?? key).replaceAll("{{count}}", String(count)),
}

describe("thinking activity row", () => {
  test("pending thinking label shimmers and body stays inside the collapsible", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <I18nProvider value={i18n}>
          <ThinkingStatus active pendingMessage={undefined} parts={[]}>
            <div data-slot="thinking-body">because the file is stale</div>
          </ThinkingStatus>
        </I18nProvider>
      ),
      host,
    )
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toContain("Thinking")
    expect(host.querySelector('[data-slot="thinking-body"]')).toBeTruthy()
    expect(host.querySelector('[data-component="reasoning-part"]')).toBeNull()
    dispose()
    host.remove()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/components/thinking-status.test.tsx` from `packages/session-ui`

Expected: FAIL — `renderable(..., false)` is `false` today; `ThinkingStatus` does not accept `children` and has no `BasicTool` title slot.

- [ ] **Step 3: Implement ThinkingStatus as a BasicTool row**

Replace the root of `ThinkingStatus` with:

```tsx
export function ThinkingStatus(props: {
  active: boolean
  pendingMessage: AssistantMessage | undefined
  parts: readonly { type: string; tool?: string }[]
  children?: JSX.Element
}) {
  // existing tick / decisions / tokens / elapsed memos stay
  const title = () =>
    props.active ? i18n.t("ui.sessionTurn.status.thinking") : i18n.t("ui.sessionTurn.status.thought")

  return (
    <BasicTool
      icon="brain"
      status={props.active ? "running" : "completed"}
      allowOpenWhilePending
      trigger={{
        title: title(),
        action:
          showDecisions() || showTokens() || showElapsed() ? (
            <span data-slot="thinking-status-stats" data-active="true">
              <Show when={showDecisions()}>
                <span data-slot="thinking-status-stat-decisions" data-active="true">
                  <span data-slot="thinking-status-stat-inner">
                    <AnimatedCountLabel count={decisions()} plural="ui.sessionTurn.thinking.decisions" />
                  </span>
                </span>
              </Show>
              <Show when={showDecisions() && showTokens()}>
                <span data-slot="thinking-status-sep">·</span>
              </Show>
              <Show when={showTokens()}>
                <span data-slot="thinking-status-stat-tokens" data-active="true">
                  <span data-slot="thinking-status-stat-inner">{tokensLabel()}</span>
                </span>
              </Show>
              <Show when={showTokens() && showElapsed()}>
                <span data-slot="thinking-status-sep">·</span>
              </Show>
              <Show when={showElapsed()}>
                <span data-slot="thinking-status-stat-elapsed" data-active="true">
                  <span data-slot="thinking-status-stat-inner">
                    <AnimatedNumber value={elapsed()} />
                    <span data-slot="thinking-status-stat-suffix">s</span>
                  </span>
                </span>
              </Show>
            </span>
          ) : undefined,
      }}
    >
      {props.children}
    </BasicTool>
  )
}
```

Import `BasicTool` from `./basic-tool`. Import `JSX` from `solid-js`. Do not keep a free-standing `[data-slot="thinking-status-label"]` sibling outside the row. `TextShimmer` is applied by `BasicTool` when `status` is `running`.

- [ ] **Step 4: Fold reasoning parts into that row**

In `renderable`:

```ts
  if (part.type === "reasoning") return !!part.text?.trim()
```

Ignore `showReasoningSummaries` for visibility. The setting remains in settings UI (later chrome slice); it must not spawn a sibling markdown block.

Replace `PART_MAPPING["reasoning"]` so it does not render `[data-component="reasoning-part"]` as a bare markdown block. Use `ThinkingStatus` with the markdown as children:

```tsx
PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const data = useData()
  const part = () => props.part as ReasoningPart
  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())
  const message = () => props.message as AssistantMessage

  return (
    <Show when={text()}>
      <div data-timeline-part-id={part().id}>
        <ThinkingStatus
          active={streaming()}
          pendingMessage={message().role === "assistant" ? message() : undefined}
          parts={[]}
        >
          <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
        </ThinkingStatus>
      </div>
    </Show>
  )
}
```

Import `ThinkingStatus` from `./thinking-status`. This is the only reasoning chrome. Do not also wrap it in a second `BasicTool`.

- [ ] **Step 5: Placeholder thinking only when no reasoning part exists**

In `session-turn.tsx` `showThinking`:

```ts
  const showThinking = createMemo(() => {
    if (!working() || !!error()) return false
    if (status().type === "retry") return false
    // Reasoning parts render their own Thinking/Thought row in AssistantParts.
    return assistantMessages().every((message) =>
      list(data.store.part?.[message.id], emptyParts).every((part) => part.type !== "reasoning" || !part.text?.trim()),
    )
  })
```

Remove the `<Show when={!showReasoningSummaries()}>` `TextReveal` heading next to thinking. Replace `TimelineThinkingRow` in `message-timeline.tsx` with:

```tsx
function TimelineThinkingRow() {
  return <ThinkingStatus active pendingMessage={undefined} parts={[]} />
}
```

Import `ThinkingStatus` from `@opencode-ai/session-ui/thinking-status`. `session-ui` package exports `"./*": "./src/components/*.tsx"`, so that path is valid.

Update `case "Thinking"` to `<TimelineThinkingRow />` with no props.

In `packages/app/src/pages/session/timeline/rows.ts`, keep emitting `TimelineRow.Thinking` only while busy with no renderable reasoning:

```ts
    const hasReasoning = assistantMessages.some((message) =>
      getMessageParts(message.id).some((part) => part.type === "reasoning" && !!part.text?.trim()),
    )
    if (isActive && status === "busy" && !error && !hasReasoning) {
      rows.push(new TimelineRow.Thinking({ userMessageID: userMessage.id }))
    }
```

Stop passing `reasoningHeading`. Leave the optional field on `TimelineRow.Thinking` so existing constructors keep typechecking. Do not delete the class field in this slice.

- [ ] **Step 6: Re-run thinking tests and session-ui typecheck**

Run: `bun test src/components/thinking-status.test.tsx src/components/message-part.test.ts src/components/basic-tool.test.tsx src/components/message-part-groups.test.ts` from `packages/session-ui`

Run: `bun typecheck` from `packages/session-ui`

Run: `bun typecheck` from `packages/app`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/session-ui/src/components/thinking-status.tsx packages/session-ui/src/components/thinking-status.css packages/session-ui/src/components/thinking-status.test.tsx packages/session-ui/src/components/message-part.tsx packages/session-ui/src/components/session-turn.tsx packages/app/src/pages/session/timeline/message-timeline.tsx packages/app/src/pages/session/timeline/rows.ts packages/app/src/pages/session/timeline/timeline-row.ts
git commit -m "feat(session-ui): collapse reasoning behind the Thinking row"
```

---

### Task 9: Retarget app locators that encoded the old chrome

**Files:**
- Modify: `packages/app/e2e/regression/session-timeline-context-resize.spec.ts`
- Modify: `packages/app/e2e/regression/session-timeline-reasoning-projection.spec.ts`

**Interfaces:**
- Consumes: Task 3 (no `data-timeline-part-ids` group node) and Task 8 (no sibling `reasoning-part`; thinking footer only before reasoning exists).
- Produces: e2e asserts one `data-timeline-part-id` per context tool; reasoning text is inside the thinking collapsible.

- [ ] **Step 1: Update the context-resize locator**

In `packages/app/e2e/regression/session-timeline-context-resize.spec.ts`, replace:

```ts
    await expectAppVisible(page.locator(`[data-timeline-part-ids="${contextIDs.join(",")}"]`).first())
```

with visibility of each individual part:

```ts
    for (const id of contextIDs) {
      await expectAppVisible(page.locator(`[data-timeline-part-id="${id}"]`))
    }
```

Follow `packages/app/e2e/AGENTS.md`: no `waitForTimeout`; keep `expectAppVisible`. If `sampleExpansion` walks the group node, point it at `[data-timeline-part-id="${contextIDs[0]}"]` (the first read row) so resize still has a target. Do not add screenshot CI.

- [ ] **Step 2: Update reasoning projection expectations**

In `session-timeline-reasoning-projection.spec.ts`, profiles that currently expect `body: true` with a sibling reasoning part should instead expect a `data-timeline-part-id` on the reasoning part and **no** `[data-component="reasoning-part"]`. Profiles that expected `thinking: true` while raw reasoning text exists should expect `thinking: false` once that text is a renderable AssistantPart (the Thinking footer is only a placeholder). Keep `thinking: true` when reasoning text is empty/whitespace.

Read the file’s `body` locator before editing. If it is `[data-component="reasoning-part"]`, change it to `[data-timeline-part-id="prt_…"]` (the reasoning part id from the fixture) or `[data-slot="thinking-body"]` / markdown inside the tool collapsible. Do not reintroduce a sibling unmuted block.

- [ ] **Step 3: Run the cheapest automated lock**

From `packages/app`:

```bash
bun test src/pages/session/timeline/rows-current.test.ts src/pages/session/timeline/projection.test.ts
bun typecheck
```

Expected: PASS. `rows-current.test.ts` mocks `groupParts` / `renderable`, so it should stay green. If a test still expects `assistant-part:…:reasoning:0` while `renderable` in production now always returns true for non-empty reasoning, that mock file is unaffected.

Do not run the full Playwright suite in this task unless the implementer already has the app e2e harness up. The locator edits are mechanical; CI Playwright is the gate.

- [ ] **Step 4: Commit**

```bash
git add packages/app/e2e/regression/session-timeline-context-resize.spec.ts packages/app/e2e/regression/session-timeline-reasoning-projection.spec.ts
git commit -m "fix(app): retarget timeline e2e after ungrouping context tools"
```

---

### Task 10: Package verification

**Files:** none new

- [ ] **Step 1: session-ui tests**

Run: `bun test src --only-failures` from `packages/session-ui`

Expected: no failures. Must include `basic-tool`, `message-part-groups`, `part-default-open`, `tool-error-card`, `thinking-status`, `shell-command-summary`.

- [ ] **Step 2: Typecheck**

Run: `bun typecheck` from `packages/session-ui`

Run: `bun typecheck` from `packages/app`

Expected: PASS.

- [ ] **Step 3: Manual scan (implementer)**

Open a session transcript with thinking → several reads/greps → edit → shell → assistant text.

Confirm:

- Each tool is one collapsed row: chevron (hover), sprite icon, verb, target.
- No “Exploring” / “Gathering context” / “Explored” group.
- Shell title is `Ran`, body still has `$ cmd` + output when expanded.
- Edit shows `+n -n` on the row, diff inside.
- Thinking/Thought is one line; expanding it shows reasoning markdown; there is no unmuted sibling `reasoning-part`.
- Failed tool: same row height, red ban icon, expand shows message + copy.
- Inter / JetBrains unchanged. Prompt, sidebar, titlebar untouched.

- [ ] **Step 4: Final commit only if Task 10 produced fixes**

If verification required code changes, commit them with a focused `fix(session-ui): ...` message. If clean, do not create an empty commit.
