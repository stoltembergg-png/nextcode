# Sidebar Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the desktop sidebar to a 48px rail and make project, workspace, and session read as three levels, without changing navigation.

**Architecture:** Restyle the production sidebar in place. `SidebarContent` switches rail width and rail buttons on the existing `mobile` prop. `ProjectIcon` and session rows do the same. `WorkspaceHeader` and the hover preview drop the `Local : name` line to a weak kind plus a medium name. No new component and no new data flow.

**Tech Stack:** SolidJS, existing `IconButton` / `IconButtonV2`, OC-2 utility classes (`text-12-medium`, `text-14-medium`, `text-14-regular`).

## Global Constraints

- Baseline `origin/dev` @ `3769875bb`. Continue on branch `cursor/sidebar-polish-spec-6cba`.
- Desktop only for the new metrics. When `mobile` is true, keep `w-16`, `px-3`, `size-8`, legacy `IconButton`, `py-1`, `text-14-medium` workspace header, and `8 + level * 16`.
- Rail is `w-12` (48px) with `px-2` and the existing `gap-3`. Avatar is `size-7` (28px). Notification dot and working spinner stay in the same corners.
- Open project, settings, help, and archive use `IconButtonV2` `variant="ghost"` `size="small"` with a JSX `icon` (`<Icon name="..." size="small" />` from `@opencode-ai/ui/v2/icon`). Glyphs stay `plus`, `settings-gear`, `help`, and `archive`.
- Project title stays `text-14-medium` `text-text-strong`. Workspace kind is `text-12-medium` `text-text-weak`. Workspace name is `text-12-medium` `text-text-base`. Session stays `text-14-regular` `text-text-strong`. There is no 13px utility. Do not add one.
- Session row padding is `py-0.5` on desktop. Child indent is `8 + level * 12`. Status slot stays `size-6`. New-session row uses the same `py-0.5`.
- Hover preview width stays `w-72` and uses the same session row and workspace header treatment.
- Do not change open, close, hover, drag, archive, rename, or workspace-menu behavior. Do not add i18n keys. No hardcoded JSX English. No `cursor.json`. Do not delete `IconButton` v1.
- Do not add a unit test that only asserts class strings. The spec forbids it. Each task ends with the browser check in that task.
- Tests, if any other package test is run, run from the package directory. Do not run tests from the repo root.
- Conventional commits: `feat(app): ...`.
- Pre-push `bun turbo typecheck` is already red on duplicate i18n keys (`TS1117` in `packages/app/src/i18n/*.ts`). Do not edit locale files. If the push fails only on that, retry with `HUSKY=0`.

**Spec:** `docs/superpowers/specs/2026-09-22-sidebar-polish-design.md`

## File map

| File | Role |
|---|---|
| `packages/app/src/pages/layout/sidebar-shell.tsx` | Desktop rail width, padding, and the three rail buttons |
| `packages/app/src/pages/layout/sidebar-items.tsx` | Avatar size, session row padding, child indent, archive button, new-session row |
| `packages/app/src/pages/layout/sidebar-project.tsx` | Pass `mobile` into the avatar and drag ghost; preview workspace header |
| `packages/app/src/pages/layout/sidebar-workspace.tsx` | Workspace header type, gated on `mobile` |
| `packages/app/src/pages/layout.tsx` | Drag ghost receives the same `mobile` flag as the rail it is drawn in |

---

### Task 1: Desktop rail

**Files:**
- Modify: `packages/app/src/pages/layout/sidebar-shell.tsx`

**Interfaces:**
- Consumes: `SidebarContent` props, including `mobile`.
- Produces: desktop rail `data-component="sidebar-rail"` with `w-12` and `px-2`. Desktop open, settings, and help controls are `data-component="icon-button-v2"`. Mobile rail stays `w-16` and legacy `IconButton`.

- [ ] **Step 1: Skip the unit test**

The spec's Testing section forbids a class-string unit test. Do not add one.

- [ ] **Step 2: Implement the rail**

Add these imports to `sidebar-shell.tsx`. Keep the legacy `IconButton` import. Do not alias `Icon`.

```tsx
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
```

Rail width:

```tsx
<div
  data-component="sidebar-rail"
  class="shrink-0 bg-background-base flex flex-col items-center overflow-hidden"
  classList={{ "w-12": !props.mobile, "w-16": !!props.mobile }}
  onMouseMove={props.aimMove}
>
```

Inner project stack. Keep `gap-3` and `py-3`.

```tsx
<div
  class="h-full w-full flex flex-col items-center gap-3 py-3 overflow-y-auto no-scrollbar"
  classList={{ "px-2": !props.mobile, "px-3": !!props.mobile }}
>
```

Open-project control, still inside the existing `Tooltip`. Settings and help use the same `Show` shape with `settings-gear` and `help`.

```tsx
<Show
  when={!props.mobile}
  fallback={
    <IconButton
      icon="plus"
      variant="ghost"
      size="large"
      onClick={props.onOpenProject}
      aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
    />
  }
>
  <IconButtonV2
    icon={<Icon name="plus" size="small" />}
    variant="ghost"
    size="small"
    onClick={props.onOpenProject}
    aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
  />
</Show>
```

Settings keeps `TooltipKeybind`, `onClick={props.onOpenSettings}`, and `aria-label={props.settingsLabel()}`. Help keeps `onClick={props.onOpenHelp}` and `aria-label={props.helpLabel()}`.

- [ ] **Step 3: Check in the browser**

Desktop sidebar:

- The rail measures 48px.
- Open project, settings, and help are 20px ghost buttons.
- Clicking each still opens the project picker, settings, and the bug-report URL.

Mobile drawer (`data-component="sidebar-nav-mobile"`):

- The rail is still 64px.
- Those three controls are still the legacy large `IconButton`.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/pages/layout/sidebar-shell.tsx
git commit -m "feat(app): tighten the desktop sidebar rail"
```

---

### Task 2: Desktop project avatar

**Files:**
- Modify: `packages/app/src/pages/layout/sidebar-items.tsx` (`ProjectIcon`)
- Modify: `packages/app/src/pages/layout/sidebar-project.tsx` (`ProjectTile`, `ProjectDragOverlay`)
- Modify: `packages/app/src/pages/layout.tsx` (overlay call site)

**Interfaces:**
- Consumes: `ProjectIcon` and `ProjectDragOverlay`.
- Produces: `ProjectIcon` accepts `mobile?: boolean`. Desktop avatar is `size-7`. Mobile avatar and the mobile drag ghost stay `size-8`.

- [ ] **Step 1: Skip the unit test**

The spec's Testing section forbids a class-string unit test. Do not add one.

- [ ] **Step 2: Size the avatar**

`ProjectIcon` props gain `mobile?: boolean`. Root class:

```tsx
<div class={`relative shrink-0 rounded ${props.mobile ? "size-8" : "size-7"} ${props.class ?? ""}`}>
```

Leave the notification dot and the working spinner markup as they are.

In `ProjectTile`, pass the flag through:

```tsx
<ProjectIcon project={props.project} mobile={props.mobile} notify working={props.isWorking()} />
```

`ProjectDragOverlay` gains `mobile?: boolean` and renders:

```tsx
<ProjectIcon project={p()} mobile={props.mobile} />
```

In `layout.tsx`, delete the shared `projectOverlay` const. Inside `sidebarContent`, pass a ghost that closes over that call's `mobile`:

```tsx
renderProjectOverlay={() => (
  <ProjectDragOverlay mobile={mobile} projects={projects} activeProject={() => store.activeProject} />
)}
```

- [ ] **Step 3: Check in the browser**

Desktop:

- The project avatar is 28px and sits fully inside the 48px rail, including the notification dot and the working spinner.
- Dragging a project still reorders it. The ghost matches the 28px avatar.

Mobile drawer:

- The avatar is still 32px.
- Dragging a project still reorders it.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/pages/layout/sidebar-items.tsx packages/app/src/pages/layout/sidebar-project.tsx packages/app/src/pages/layout.tsx
git commit -m "feat(app): shrink the desktop project avatar"
```

---

### Task 3: Desktop session rows

**Files:**
- Modify: `packages/app/src/pages/layout/sidebar-items.tsx` (`SessionRow`, `SessionItem`, `NewSessionItem`)

**Interfaces:**
- Consumes: `SessionItemProps.mobile` and `SessionItemProps.level`.
- Produces: desktop session and new-session rows at `py-0.5`, desktop child indent `8 + level * 12`, desktop archive control `data-component="icon-button-v2"`. Session title class stays `text-14-regular`. Status slot stays `size-6`.

- [ ] **Step 1: Skip the unit test**

The spec's Testing section forbids a class-string unit test. Do not add one.

- [ ] **Step 2: Tighten the rows**

`sidebar-items.tsx` already imports `Icon as IconV2` from `@opencode-ai/ui/v2/icon`. Add `IconButtonV2` from `@opencode-ai/ui/v2/icon-button-v2`. Keep the legacy `IconButton` import for the mobile archive control.

`SessionRow` link class:

```tsx
class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.mobile && !props.dense ? "py-1" : "py-0.5"}`}
```

`SessionItem` row indent:

```tsx
style={{ "padding-left": `${8 + (props.level ?? 0) * (props.mobile ? 16 : 12)}px` }}
```

Archive control. Keep the surrounding width/opacity classes and the `onClick` that calls `props.archiveSession`.

```tsx
<Show
  when={!props.mobile}
  fallback={
    <IconButton
      icon="archive"
      variant="ghost"
      class="size-6 rounded-md"
      aria-label={language.t("common.archive")}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void props.archiveSession(props.session)
      }}
    />
  }
>
  <IconButtonV2
    icon={<IconV2 name="archive" size="small" />}
    variant="ghost"
    size="small"
    aria-label={language.t("common.archive")}
    onClick={(event) => {
      event.preventDefault()
      event.stopPropagation()
      void props.archiveSession(props.session)
    }}
  />
</Show>
```

`NewSessionItem` link class:

```tsx
class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.mobile && !props.dense ? "py-1" : "py-0.5"}`}
```

Do not change the session title span, the status `size-6` slot, or the new-session label span.

- [ ] **Step 3: Check in the browser**

Desktop:

- A session row is shorter than before and the title is still 14px regular, one line, truncated.
- A child session sits 12px further right than its parent.
- Hovering a root session reveals archive. Activating it still archives.
- "New session" matches the session row height.
- Working, permission, error, and unseen markers still occupy the 24px slot.

Mobile drawer:

- Session rows keep `py-1`.
- Child indent is still 16px per level.
- Archive is still the legacy `IconButton`.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/pages/layout/sidebar-items.tsx
git commit -m "feat(app): tighten desktop session rows"
```

---

### Task 4: Workspace header and hover preview

**Files:**
- Modify: `packages/app/src/pages/layout/sidebar-workspace.tsx` (`WorkspaceHeader`, `SortableWorkspace`)
- Modify: `packages/app/src/pages/layout/sidebar-project.tsx` (`ProjectPreviewPanel`, `SortableProject`)

**Interfaces:**
- Consumes: `WorkspaceHeader` and `SortableWorkspace`'s existing `mobile` prop. `workspace.type.local` and `workspace.type.sandbox`.
- Produces: desktop header and preview show the kind in `text-12-medium text-text-weak` and the name in `text-12-medium text-text-base`, with no colon between them. Mobile header stays `text-14-medium` and keeps the colon. Project title in the preview stays `text-14-medium text-text-strong`.

- [ ] **Step 1: Skip the unit test**

The spec's Testing section forbids a class-string unit test. Do not add one.

- [ ] **Step 2: Restyle the workspace header**

Add `mobile?: boolean` to `WorkspaceHeader`. Pass `mobile={props.mobile}` from `SortableWorkspace`'s `header()` call.

Kind and name classes:

```tsx
const kindClass = props.mobile
  ? "text-14-medium text-text-base shrink-0"
  : "text-12-medium text-text-weak shrink-0"
const nameClass = props.mobile
  ? "text-14-medium text-text-base min-w-0 truncate"
  : "text-12-medium text-text-base min-w-0 truncate"
```

`WorkspaceHeader` is a plain function, so these two consts sit in the function body. The branch icon keeps `name="branch"` and `size="small"`. On desktop add `class="text-icon-weak"`. On mobile leave the icon class unset.

Kind text. Desktop has no colon. Mobile keeps the colon so the current line stays intact.

```tsx
<span class={kindClass}>
  {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")}
  {props.mobile ? " :" : ""}
</span>
```

Local name span uses `nameClass`. The sandbox `InlineEditor` gets `class={nameClass}` and `displayClass={nameClass}`.

- [ ] **Step 3: Match the hover preview**

`ProjectPreviewPanel` is only mounted from the desktop hover card (`preview()` is `!props.mobile`). Replace the combined workspace label.

In `SortableProject`, replace `label` with `workspaceTitle`. Keep the branch lookup that `label` uses today:

```tsx
const workspaceTitle = (directory: string) => {
  const [data] = serverSync().child(directory, { bootstrap: false })
  return props.ctx.workspaceLabel(directory, data.vcs?.branch, props.project.id)
}
```

Pass `title={workspaceTitle}` instead of `label={label}`. Remove `label` from `ProjectPreviewPanel`'s props and add:

```tsx
title: (directory: string) => string
```

Preview workspace block. Do not call `serverSync` inside the `For` callback.

```tsx
<div class="px-2 py-0.5 flex items-center gap-1 min-w-0">
  <div class="shrink-0 size-6 flex items-center justify-center">
    <Icon name="branch" size="small" class="text-icon-weak" />
  </div>
  <span class="shrink-0 text-12-medium text-text-weak">
    {directory === props.project.worktree
      ? props.language.t("workspace.type.local")
      : props.language.t("workspace.type.sandbox")}
  </span>
  <span class="min-w-0 truncate text-12-medium text-text-base">{props.title(directory)}</span>
</div>
```

Leave the project title `text-14-medium text-text-strong` and the "recent sessions" line unchanged. Leave `w-72`.

- [ ] **Step 4: Check in the browser**

Desktop panel:

- A workspace reads as a weak 12px kind (`Local` or `Sandbox`) and a 12px medium name on one line, without a colon.
- The branch icon is weak. Expand, rename, reset, and delete still work from the existing menu.
- The project title above a preview is still 14px medium.

Desktop hover preview:

- The workspace line matches the panel header.
- The two recent sessions match the panel's session row.

Mobile drawer:

- The workspace line is still 14px medium and still includes the colon (`Local :` / `Sandbox :`).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/layout/sidebar-workspace.tsx packages/app/src/pages/layout/sidebar-project.tsx
git commit -m "feat(app): separate workspace type from its name"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| Desktop rail `w-12`, `px-2`, `gap-3` | 1 |
| Rail `IconButtonV2` ghost small for plus, settings, help | 1 |
| Avatar `size-7`, dot and spinner stay | 2 |
| Mobile avatar `size-8` and mobile drag ghost | 2 |
| Session `py-0.5`, title stays `text-14-regular` | 3 |
| Child indent `8 + level * 12` | 3 |
| Archive `IconButtonV2` on hover | 3 |
| New session `py-0.5` | 3 |
| Status slot `size-6` | 3 (unchanged) |
| Workspace kind 12 weak, name 12 medium, no colon | 4 |
| Preview uses the same header and row, width `w-72` | 4 |
| Project title `text-14-medium` | 4 (unchanged) |
| Mobile keeps the old metrics | 1, 2, 3, 4 |
| No class-string unit test | every task, step 1 |
