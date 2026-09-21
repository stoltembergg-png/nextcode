# Upstream Sync Design

**Date:** 2026-09-19
**Status:** Approved in conversation
**Repository:** `D:\Projetos\JevCode`

## Intent

Synchronize the NextCode fork with the OpenCode `dev` branch before beginning the native OMO work. The sync must preserve published fork history, intentional product removals, and all user-owned working-tree changes.

## Repository Snapshot

The design was based on freshly fetched refs:

- `origin/dev`: `83abc64a5c`
- `jevcode/dev`: `3f685f566a`
- merge base: `5a8335857b`
- `jevcode/dev` relative to `origin/dev`: 149 commits ahead and 20 behind
- current checkout: `tauri-shell`
- current checkout has an unrelated modification in `packages/core/src/filesystem/search.ts`
- `D:\Projetos\JevCode\nextcode` is a separate nested checkout and is outside this work

The implementation must fetch both remotes again before acting because these refs can move.

## Merge Strategy

Use a merge, not a rebase. The fork history is already published and contains merge commits, release tags, native SemIf work, desktop packaging, and product-specific removals. Rewriting those commits would make review and recovery harder.

Perform the sync in an isolated worktree created from the refreshed `jevcode/dev`. Use the short branch name `upstream-sync`. The dirty `tauri-shell` checkout must not be stashed, reset, cleaned, or otherwise modified.

The sync is its own milestone and merge commit. It must not contain OMO implementation changes.

## Conflict Policy

A pre-merge comparison found 75 overlapping paths. They are overwhelmingly modify/delete conflicts in packages intentionally removed by NextCode:

- `packages/console`
- `packages/web`
- `packages/stats`

Preserve those deletions. Do not restore removed OpenCode products merely to accept upstream changes.

For maintained packages, resolve conflicts by preserving NextCode product behavior while adopting compatible upstream fixes. Do not choose a blanket `ours` or `theirs` strategy. Each maintained conflict must be reviewed against its base, fork, and upstream versions.

Generated files follow repository rules:

- never edit `packages/client/src/generated` or `packages/client/src/generated-effect` directly;
- after a public Protocol or Server `HttpApi` change, run `bun run generate` from `packages/client`;
- regenerate the legacy JavaScript SDK with `./packages/sdk/js/script/build.ts` when its source contract changes.

## Validation

Validation happens in two layers:

1. Establish the applicable fork baseline from `jevcode/dev` before the merge.
2. Run the same checks after conflict resolution and compare failures with the baseline.

Tests and typechecks must run from package directories, never from the repository root. Type checking uses `bun typecheck`, never direct `tsc`.

At minimum, validate every maintained package changed by the 20 upstream commits or by conflict resolution. Also validate the existing SemIf server, app, desktop packaging configuration, generated client surface when affected, and the release workflow syntax.

## Deliverable

The result is a reviewable `upstream-sync` branch whose only semantic purpose is bringing `origin/dev` into the NextCode fork while preserving intentional fork behavior. Native OMO work starts only from this validated synchronized base.

## Acceptance Criteria

- The merge retains published fork history.
- The current dirty checkout and nested `nextcode` checkout remain untouched.
- `console`, `web`, and `stats` remain removed.
- Maintained-package conflicts are resolved deliberately.
- Applicable pre-merge checks do not regress after the merge.
- Required generated artifacts are produced only by their generators.
- The sync is isolated from native OMO implementation commits.
