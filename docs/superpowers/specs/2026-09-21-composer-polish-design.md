# Composer visual polish (Cursor-like)

**Status:** approved for implementation planning  
**Baseline:** `origin/dev` @ `0f38503f8`  
**Slice:** 2 of the app-wide visual polish program  
**Depends on:** slice 1 transcript activity rows (`BasicTool` activity anatomy)

## Problem

The production composer is already `PromptInputV2` (`settings.general.newLayoutDesigns` is forced on after `oldInterfaceSunset`). It still does not read as one compact card:

- The form is `min-h-[96px]` with a `h-11` toolbar and a `min-h-[60px]` editor.
- Send/stop uses the legacy `IconButton`. The add menu already uses `IconButtonV2`.
- Todo, revert, permission, and question are sibling docks stacked above the input, with a `lift` overlap of 18px or 36px.
- New-session mounts the same `PromptInputV2Composer`, inside an unchanged hero.

## Product rule

One compact composer card. Todos and revert are a single strip on that card. An open permission or question is an activity row in the transcript, same anatomy as slice 1, not a dock. New-session gets the same card and keeps its hero.

## Decisions (locked)

| Axis | Choice |
|---|---|
| Surface | Session composer card, its todo/revert/permission/question docks, and the new-session composer card |
| Implementation | Polish production `PromptInputV2` in place. Do not build a new composer. Leave `PromptInput` v1 compiled as the dead fallback |
| Card density | Compact: editor grows from one line, thin toolbar, send/stop on `IconButtonV2` |
| Todos + revert | One strip inside the card. Hidden when both are empty. Closed by default |
| Permission + question | Leave the composer stack. Render once as a transcript activity row while the request is open |
| Followup | Stays a dock above the card |
| New-session | Same compact card. No hero, title, or project-picker redesign. No strip (no turn yet) |
| Fonts / icons / theme | Inter, JetBrains Mono, existing SVG sprite, OC-2 / v2 tokens. No `cursor.json` |
| Copy | Existing i18n keys. No hardcoded JSX English |
| Behavior of submit | `createPromptSubmit` error path unchanged. No new toast |

## Non-goals

Protocol, `SessionV2.prompt`, inbox, permissions engine, sidebar, tabs, titlebar, settings, terminal, review panel, new-session hero, deleting `PromptInput` v1, promoting `BasicToolV2`, Linux/Tauri packaging, screenshot-gated CI.

## Architecture

```text
MessageTimeline
  Permission activity row     open PermissionRequest, BasicTool body = existing decide UI
  Question activity row       open QuestionRequest, BasicTool body = existing answer UI
SessionComposerRegion
  SessionFollowupDock         unchanged, only when a queued draft exists
  PromptInputV2
    strip                     todos and/or revert, optional, collapsed
    editor + thin toolbar
New-session
  existing hero
  PromptInputV2               no strip
```

### PromptInputV2

`packages/session-ui/src/v2/components/prompt-input/index.tsx`

- Drop the form `min-h-[96px]` and the editor `min-h-[60px]`. The editor stays `max-h-[180px]` and grows with content from a single line (`min-h` of one `leading-5` row plus the existing padding).
- Toolbar is content-sized, not `h-11`.
- `PromptInputV2SubmitButton` renders `IconButtonV2` (`data-component="icon-button-v2"`) with the existing sprite `Icon` as its `icon` child. `IconButtonV2` does not take an icon name string.
- Optional `strip` prop. When omitted or empty, the form starts at the editor. The session page passes it; new-session does not.

Strip contract:

```ts
strip?: {
  label: string
  expanded: boolean
  onToggle: () => void
  body?: JSX.Element
}
```

One label for the whole strip. The app builds it from the counts it already has. Zero todos and zero revert items: pass `strip` undefined. Clicking the strip toggles `expanded`. The body is the existing todo list and/or revert list, rendered by the app and placed inside the card. Default `expanded` is false.

### SessionComposerRegion

`packages/app/src/pages/session/composer/session-composer-region.tsx`

Stop mounting `SessionQuestionDock`, `SessionPermissionDock`, `SessionTodoDock`, and `SessionRevertDock`.

Keep `SessionFollowupDock` in its current slot above `promptInput`.

The region passes todo and revert state into the prompt input through the strip, instead of sibling docks. `lift` overlap that only existed to tuck those docks under the composer goes away with them. Followup keeps its current placement and does not use that overlap.

`SessionPermissionDock` and `SessionQuestionDock` stay as the body components. They lose the outer `DockPrompt` frame when rendered inside the activity row, so the row is the only chrome. Their handlers stay: permission `onDecide("once" | "always" | "reject")`, question `onSubmit`.

### Transcript rows

Permission and question rows are derived from the same live request signals the docks use today (`controller.state.permissionRequest()`, `controller.state.questionRequest()`). They are not new protocol fields and they are not durable timeline tags stored on the session.

While a request is open, `MessageTimeline` renders one activity row for it on the active turn:

- Trigger matches slice 1: chevron, sprite icon, i18n title, muted target (permission patterns, or the question prompt), collapsed by default.
- Body is the existing dock content (Allow once / Allow always / Deny, or the question form).
- Answering calls the current handler and the request clears, so the row unmounts.
- Abort or dismiss that already clears the request unmounts the row. No second footer card.
- A pending question tool part that would duplicate the open request is not rendered beside this row.

`BasicTool` is the row. Do not introduce an `ActivityRow` component.

### Copy

Reuse:

- `notification.permission.title`, `ui.permission.deny`, `ui.permission.allowAlways`, `ui.permission.allowOnce`
- `session.todo.progress` (`{{done}} of {{total}} todos completed`)
- `session.revertDock.summary.one` / `.other`

When both are present, the strip label is the todo progress string, a middle dot, then the revert summary. Do not add a parallel vocabulary.

### New-session

`packages/app/src/pages/new-session/new-session-view.tsx` keeps its hero and project chrome. It keeps `PromptInputV2Composer` and does not pass `strip`.

## Error handling

Composer submit failures stay on `createPromptSubmit`. Permission `responding` still disables the three actions. Revert `restoring` / `disabled` still disable restore. An empty strip is absence, not an empty expanded panel.

## Testing

Run from package directories, never the repo root. session-ui DOM tests use `bun test --conditions=browser`.

- `PromptInputV2` form has no `min-h-[96px]` and its toolbar has no `h-11`.
- Submit control is `IconButtonV2`.
- Strip is absent when `strip` is omitted, and present with the label when `strip` is set. Body is hidden until `expanded`.
- `SessionComposerRegion` does not mount permission, question, todo, or revert docks. It still mounts the followup dock when followup items exist.
- The timeline shows one permission or question activity row while that request is open, and does not show it after the request clears.
- New-session still mounts `PromptInputV2` and does not render the strip.

## Success

A session with open todos and a revert reads as one short card: one strip line, a one-line editor, a thin toolbar, send on the v2 icon button. An open permission or question is a collapsed activity row in the transcript, with the current actions inside it. The new-session page shows that same card under the current hero.
