# Sidebar visual polish (Cursor-like)

**Status:** approved for implementation planning  
**Baseline:** `origin/dev` @ `3769875bb`  
**Slice:** 3 of the app-wide visual polish program  
**Depends on:** slice 1 transcript activity rows, slice 2 composer card

## Problem

The desktop sidebar is still the wide legacy rail plus a panel where project, workspace, and session share one type size.

Today, in production (`SidebarContent`, `ProjectIcon`, `SessionItem`, `WorkspaceHeader`):

- The rail is `w-16` (64px) with 32px project avatars.
- Open project, settings, and help use the legacy `IconButton` at `size="large"`. Archive on a session row does too.
- A workspace header is `Local : name` in `text-14-medium`, the same size as the project title. Session titles are `text-14-regular`.
- An expanded session row is `py-1`. A child session indents by 16px per level.
- The type scale in `packages/ui/src/styles/utilities.css` has 12 and 14. There is no 13.

The panel already has the right structure: project rail, workspace sections, session rows, hover preview. The levels do not read apart, and the rail is heavier than the composer card beside it.

## Product rule

One tighter desktop sidebar. Same navigation. Project, workspace, and session separate by type size, weight, and color. Mobile keeps the current metrics.

## Decisions (locked)

| Axis | Choice |
|---|---|
| Surface | Desktop sidebar rail, expanded session panel, and the project hover preview |
| Implementation | Restyle production sidebar components in place. No new sidebar, no single-column tree |
| Rail | `w-12` (48px). Horizontal padding `px-2` so a 28px avatar fits. Vertical order and `gap-3` stay |
| Project avatar | `size-7` (28px). Notification dot and working spinner stay in the same corners |
| Rail actions | Open project, settings, and help use `IconButtonV2` `variant="ghost"` `size="small"`, with the existing sprite `Icon` as the `icon` child |
| Archive | Same `IconButtonV2` ghost small, still shown on hover and focus |
| Project title | `text-14-medium` `text-text-strong` |
| Workspace | Kind (`Local` / `Sandbox`) is `text-12-medium` `text-text-weak`. Name is `text-12-medium` on the same line. Branch icon stays |
| Session | `text-14-regular` `text-text-strong`, one line, truncate. Row padding `py-0.5` |
| Child session | Same session type. Extra indent is 12px per level (`8 + level * 12`), down from 16px |
| New session | Same row height as a session (`py-0.5`) |
| Status slot | Stays 24px (`size-6`): working spinner, permission, error, unseen |
| Hover preview | Uses the same session row and workspace header. Preview width stays `w-72` |
| Mobile | Unchanged. Shared components keep today's classes when `mobile` is true |
| Fonts / icons / theme | Inter, JetBrains Mono, existing SVG sprite, OC-2 / v2 tokens. No `cursor.json` |
| Copy | Existing i18n keys. No hardcoded JSX English |

`IconButtonV2` takes a JSX `icon`, not a name string. Glyphs stay `plus`, `settings-gear`, `help`, and `archive`. Small is 20px in `icon-button-v2.css`.

## Non-goals

Titlebar, tabs, settings page, terminal, review panel, mobile sidebar metrics, open/close/hover/drag behavior, archive/rename/workspace-menu behavior, session list data, deleting `IconButton` v1, promoting a new sidebar component, Linux/Tauri packaging, screenshot-gated CI.

## Architecture

```text
SidebarContent (desktop)
  rail w-12
    ProjectIcon size-7
    IconButtonV2  open project, settings, help
  panel
    WorkspaceHeader   kind 12 weak, name 12 medium
    NewSessionItem    py-0.5
    SessionItem       py-0.5, child indent 12px, archive IconButtonV2
Project hover preview
  same WorkspaceHeader and SessionItem
```

Mobile passes `mobile` and keeps `w-16`, `size-8`, legacy `IconButton`, `py-1`, `text-14-medium` workspace header, and `8 + level * 16`.

### Files

- `packages/app/src/pages/layout/sidebar-shell.tsx` — rail width, rail padding, three rail buttons.
- `packages/app/src/pages/layout/sidebar-items.tsx` — avatar size, session row padding and archive button, child indent, new-session row height.
- `packages/app/src/pages/layout/sidebar-workspace.tsx` — workspace header type. Thread `mobile` through when this header renders in the mobile tree.
- `packages/app/src/pages/layout/sidebar-project.tsx` — hover preview uses the updated row and header. No separate preview chrome.

No new components. No context or route changes.

### Data flow

Unchanged. Project order, workspace expand, session prefetch, archive, and hover-open still come from the existing layout context. This spec only changes desktop class names and which button component the rail and archive control render.

### Error handling

No new failure path. Archive, rename, reset, and delete keep their current handlers.

## Testing

No sidebar unit test exists, and this slice adds no logic. Do not add a test that only asserts class strings.

Verify in the browser on desktop:

- The rail is 48px and the 28px avatar is fully inside it.
- Project, workspace, and session read as three levels.
- Archive appears on row hover and activates.
- The hover preview matches the panel's row and workspace header.
- Open, close, hover-open, and drag still work.
- The mobile drawer (`mobile` true, `data-component="sidebar-nav-mobile"`) keeps the previous rail width, avatar size, and row padding.

## Later slices

Slice 4 is the titlebar and window chrome. Slice 5 is the terminal and review panels. Each gets its own spec.
