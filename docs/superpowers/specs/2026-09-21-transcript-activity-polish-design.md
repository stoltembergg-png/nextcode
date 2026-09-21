# Transcript activity visual polish (Cursor-like)

**Status:** approved for implementation planning  
**Baseline:** `origin/dev` @ `6936ab116`  
**Slice:** 1 of the app-wide visual polish program (full app is multiple specs)  
**Non-goals:** prompt/composer, sidebar, tabs, titlebar, settings, terminal panel, Lucide/Phosphor, `cursor.json` theme pack, promoting `BasicToolV2` to production, protocol/runner/session execution changes, Linux/Tauri packaging, screenshot-gated CI

## Problem

The live transcript already has the right data: tool parts, shell output, diffs, thinking, errors. The chrome does not read like Cursor’s composer activity list.

Today, in production (`MessageTimeline` / `SessionTurn` → `message-part.tsx` → `BasicTool`):

- `BasicTool.icon` is accepted and **not drawn**.
- Title is a verb (`Read`, `Edit`); the path sits in a muted subtitle/args slot.
- Consecutive `read` / `glob` / `grep` / `list` collapse into `ContextToolGroup` (“Gathering context”).
- Shell default-opens; edit/write stay closed.
- Thinking is a shimmer line; reasoning markdown is a **separate** unmuted-muted block, not behind that line.
- Inter + JetBrains Mono + the in-repo SVG sprite already exist. There is a color theme named `cursor.json`; it is a palette, not this layout.

Users scanning a turn cannot read “what happened” as a dense stack of icon + verb + target rows.

## Product rule

One activity line per tool (and one thinking line). Cursor composer density: collapsed by default, expand for output. Same fonts and icon sprite. Presentation-only: pending/done/error still come from existing part status.

## Decisions (locked)

| Axis | Choice |
|---|---|
| Surface this cycle | Transcript activity only |
| Tool row | Icon (sprite) + short verb + path/target on **one** line |
| Default expand | **All collapsed**, including shell and edit/write/patch |
| Open while pending | Blocked, except shell (`allowOpenWhilePending` stays) |
| Context grouping | **Remove** `ContextToolGroup`; each read/grep/list/glob is its own row |
| Thinking | One “Thinking” line + optional elapsed; reasoning is the **collapsed body** of that line |
| Thinking done | Same line, static title (Thought); expand still shows reasoning markdown |
| Error | Same row anatomy; failure icon; short subtitle; body = message + copy |
| Fonts | Keep Inter (UI) and JetBrains Mono (code/shell). Tighten weight/size/gap on the row only |
| Icons | Existing `packages/ui` SVG sprite, **rendered** on the row. No new icon library |
| Theme | Keep OC-2 / v2 tokens. Do not switch transcript to `cursor.json` |
| Implementation path | Polish production `BasicTool` + `message-part` + thinking. Do not migrate to `BasicToolV2` |
| Copy | English source via i18n keys. No hardcoded JSX English |

Later slices (separate specs): prompt, sidebar/tabs, terminal/review panels, app chrome.

## Architecture

```text
SessionTurn / MessageTimeline
  ThinkingStatus | TimelineThinkingRow     thinking line + collapsible reasoning
  message-part PART_MAPPING
    BasicTool                              canonical activity row
    ToolErrorCard                          same row anatomy, error icon
    (no ContextToolGroup)
```

Units:

- **`BasicTool`** (`packages/session-ui/src/components/basic-tool.tsx` + `basic-tool.css`): canonical row. Renders sprite `icon`, title (verb), subtitle (path/target), optional `+n -n`, hover chevron, `TextShimmer` on the verb iff pending. Default closed. Body is existing collapsible content.
- **`message-part` registry** (`message-part.tsx` + `message-part.css`): each tool fills `BasicTool` with icon + `ui.tool.*` verb + one-line target. Delete `ContextToolGroup` and its “Gathering/Gathered context” copy path.
- **Thinking** (`thinking-status.tsx`, `session-turn.tsx`, app `timeline/message-timeline.tsx` `TimelineThinkingRow`): one line; elapsed allowed; reasoning part is **not** a free-standing `reasoning-part` block when this chrome is shown — it is the collapsed body. Unify app timeline and SessionTurn so they do not diverge.
- **`ToolErrorCard`**: same trigger layout as `BasicTool` (icon + verb + target + error subtitle). Body remains the error text + copy control.
- **`part-default-open.ts`**: shell/bash default **closed**. Edit/write/patch stay closed (already). Forced-open only if an existing explicit override requires it (none for this slice).

### Data flow

Unchanged. Parts still stream with the same statuses. This spec only changes how `message-part` and thinking **render** those parts. Do not add new protocol fields.

### Row contract

Every activity trigger is:

1. Chevron (opacity 0 until hover; rotates when open) — keep current behavior
2. Sprite icon (`BasicTool` must paint `props.icon`)
3. Verb (i18n, medium weight, shimmer iff pending)
4. Target (muted, ellipsis): filepath, pattern, URL, or summarized command
5. Trailing meta only when it already exists: edit `+n -n`; thinking elapsed `Ns`

Expanded body (unchanged engines, restyle chrome only if required for density):

- shell: `$ cmd` + output (already)
- grep/list/glob/read: existing output / file chips
- edit/write/patch: existing diff
- thinking: reasoning markdown (`PacedMarkdown` as today)
- error: message + copy

### Copy (English source)

Reuse existing keys where they already match (`ui.tool.read`, `ui.tool.edit`, …). Add keys only when missing:

| State | English source |
|---|---|
| Thinking pending | `Thinking` (reuse existing key if the English source is already this) |
| Thinking done with reasoning | `Thought` (new key if missing) |
| Shell verb | `Ran` (new key if the current bash/shell title is not this) |
| Error subtitle | existing tool error strings |

Do not invent parallel vocabularies (`Called {tool}` vs `Read`). Generic/MCP tools keep a single `Called {name}` line + icon `mcp`.

`todowrite` stays hidden from the transcript (current behavior).

## Error handling

Tool failure does not introduce a new layout system. `ToolErrorCard` must visually read as an activity row: same height, same icon slot, same verb+target, red/danger icon token already used by the card. Expand still reveals the full error. Copy control stays.

A pending tool that errors swaps shimmer off and uses the error row. No dual chrome (error card stacked on a success row).

## Testing

Run from `packages/session-ui` (never repo root).

Minimum automated coverage (extend existing component tests / add focused ones next to the files above):

- `BasicTool` trigger **contains** the icon node when `icon` is set
- Read/grep/list/glob each render as their **own** row (no “Gathering context” group)
- Shell and edit default **closed** after done
- Thinking line is present while working; reasoning is **not** a sibling block — it is inside the thinking collapsible
- Error uses the same trigger structure (icon + title + subtitle)

No visual-regression / screenshot CI in this slice. No `packages/core` tests.

## Constraints

- Keep things in one function unless reused; do not extract a new `ActivityRow` type.
- No `any`. Prefer existing Solid patterns in `session-ui`.
- i18n: English in source locale files, never raw English in JSX for user-visible verbs.
- `packages/core` must not import `opencode`. This slice must not import Core from Client.
- Linux desktop spec’s “byte-identical UI except titlebar” applied to **that** packaging work. This spec **is** a UI change, scoped to transcript activity, and is the approved exception for this program’s slice 1.

## Success

A turn with thinking → several reads/greps → edit → shell → assistant text scans as a Cursor-like stack of one-line activity rows, all collapsed, icons visible, Inter/JetBrains unchanged, no gathering group, reasoning behind Thinking/Thought.
