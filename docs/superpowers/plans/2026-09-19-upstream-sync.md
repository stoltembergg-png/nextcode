# Upstream Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the refreshed OpenCode `origin/dev` history into the published NextCode `jevcode/dev` history without rewriting commits, restoring intentionally removed products, or touching the user's dirty checkout.

**Architecture:** Perform the synchronization on a dedicated `upstream-sync` branch in an isolated managed worktree created from the refreshed `jevcode/dev`. Capture a pre-merge baseline, merge `origin/dev` without auto-committing, resolve each conflict by policy, regenerate contracts only through repository generators, then compare the post-merge result with the recorded baseline before creating the merge commit.

**Tech Stack:** Git, PowerShell, Bun workspace scripts, Effect TypeScript packages, GitHub Actions YAML, Tauri/Electron packaging configuration.

**Spec:** `docs/superpowers/specs/2026-09-19-upstream-sync-design.md`

## Global Constraints

- Work from `dev`; do not use or assume a local `main` ref.
- Use a merge, never rebase or cherry-pick the upstream range.
- Do not stash, reset, clean, checkout, stage, or otherwise alter the existing `tauri-shell` checkout.
- Treat `D:\Projetos\JevCode\nextcode` as a separate nested checkout and never traverse, clean, stage, or modify it.
- Preserve the intentional removal of `packages/console`, `packages/web`, and `packages/stats`.
- Review every maintained-file conflict against merge base, fork side, and upstream side. Do not apply repository-wide `ours` or `theirs` strategies.
- Never edit `packages/client/src/generated` or `packages/client/src/generated-effect` by hand.
- Run tests and `bun typecheck` from package directories, never from repository root, and never invoke `tsc` directly.
- Keep this branch limited to the upstream merge and necessary generated outputs. Native OMO work starts from the validated result in a separate branch.

## Review Focus

1. **User work is mutated:** prove before and after that the original checkout branch, status, and dirty-file hashes are unchanged.
2. **Removed products return:** assert that `packages/console`, `packages/web`, and `packages/stats` remain absent after conflict resolution.
3. **Maintained conflicts are resolved mechanically:** keep a conflict ledger with base/fork/upstream intent and the chosen resolution for every maintained path.
4. **Generated contracts drift:** regenerate only when source contracts changed and require generator/check commands to leave no unexplained diff.
5. **The merge introduces regressions:** record the applicable baseline on refreshed `jevcode/dev`, run the same checks after the merge, and classify every delta.

---

## Task 1: Freeze the user checkout and refresh remote evidence

**Files:**

- Create outside Git: `%TEMP%\nextcode-upstream-sync\source-state.txt`
- Create outside Git: `%TEMP%\nextcode-upstream-sync\source-hashes.txt`
- Create outside Git: `%TEMP%\nextcode-upstream-sync\refs.txt`

- [ ] **Step 1: Resolve and record the source checkout without changing it**

Run from `D:\Projetos\JevCode`:

```powershell
$audit = Join-Path $env:TEMP "nextcode-upstream-sync"
New-Item -ItemType Directory -Force -Path $audit | Out-Null
git rev-parse --show-toplevel
git branch --show-current
git status --short --branch
git worktree list --porcelain
```

Expected: the root is `D:/Projetos/JevCode`, the active branch is `tauri-shell`, and the output still shows the user-owned `packages/core/src/filesystem/search.ts` modification plus the untracked nested `nextcode/` checkout.

- [ ] **Step 2: Persist a source-state fingerprint**

```powershell
git status --porcelain=v1 --untracked-files=all | Set-Content -LiteralPath (Join-Path $audit "source-state.txt")
git diff --binary -- packages/core/src/filesystem/search.ts | git hash-object --stdin | Set-Content -LiteralPath (Join-Path $audit "source-hashes.txt")
git rev-parse HEAD | Add-Content -LiteralPath (Join-Path $audit "source-hashes.txt")
```

Expected: the audit files are outside the repository. Do not hash or enumerate the nested `nextcode/` contents.

- [ ] **Step 3: Fetch both remotes and record immutable object IDs**

```powershell
git fetch --prune origin dev
git fetch --prune jevcode dev
$originDev = git rev-parse origin/dev
$jevcodeDev = git rev-parse jevcode/dev
$mergeBase = git merge-base origin/dev jevcode/dev
@(
  "origin/dev=$originDev"
  "jevcode/dev=$jevcodeDev"
  "merge-base=$mergeBase"
  "ahead-behind=$(git rev-list --left-right --count jevcode/dev...origin/dev)"
) | Set-Content -LiteralPath (Join-Path $audit "refs.txt")
Get-Content -LiteralPath (Join-Path $audit "refs.txt")
```

Expected: all three object IDs resolve. Divergence may differ from the design snapshot because refs can move; the recorded IDs, not the historical counts, govern this execution.

- [ ] **Step 4: Confirm ancestry and inspect incoming history**

```powershell
git merge-base --is-ancestor $mergeBase jevcode/dev
git merge-base --is-ancestor $mergeBase origin/dev
git log --oneline --decorate --no-merges jevcode/dev..origin/dev
git diff --stat jevcode/dev...origin/dev
```

Expected: both ancestry checks exit `0`; the log and diff describe the current upstream-only range.

- [ ] **Step 5: Do not commit audit artifacts**

No repository commit is created in this task. The audit directory remains external evidence for the final invariant check.

## Task 2: Create the isolated branch and worktree

**Files:**

- Create worktree: `D:\Projetos\JevCode-worktrees\upstream-sync` or another explicit sibling path
- Branch: `upstream-sync`

- [ ] **Step 1: Check that the branch and intended worktree path are available**

```powershell
$syncRoot = "D:\Projetos\JevCode-worktrees\upstream-sync"
git show-ref --verify --quiet refs/heads/upstream-sync
if (Test-Path -LiteralPath $syncRoot) { Resolve-Path -LiteralPath $syncRoot }
```

Expected: `refs/heads/upstream-sync` does not exist and the target directory does not exist. If either exists, stop and inspect it; do not delete or overwrite it.

- [ ] **Step 2: Create the branch at the recorded fork tip**

```powershell
$jevcodeDev = (Get-Content -LiteralPath (Join-Path $audit "refs.txt") | Where-Object { $_ -like "jevcode/dev=*" }).Split("=")[1]
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $syncRoot) | Out-Null
git worktree add -b upstream-sync $syncRoot $jevcodeDev
```

Expected: Git creates a clean worktree whose `HEAD` equals the recorded `jevcode/dev` object ID.

- [ ] **Step 3: Verify isolation from inside the new worktree**

```powershell
git branch --show-current
git rev-parse HEAD
git status --short --branch
```

Run with working directory `D:\Projetos\JevCode-worktrees\upstream-sync`.

Expected: branch `upstream-sync`, the recorded fork tip, and a clean status. The nested checkout is not present in this worktree.

## Task 3: Establish the refreshed fork baseline

**Files:**

- Create outside Git: `%TEMP%\nextcode-upstream-sync\baseline.tsv`
- Create outside Git: `%TEMP%\nextcode-upstream-sync\changed-files.txt`
- Create outside Git: `%TEMP%\nextcode-upstream-sync\changed-packages.txt`

- [ ] **Step 1: Compute the maintained scope touched by upstream**

```powershell
$originDev = (Get-Content -LiteralPath (Join-Path $audit "refs.txt") | Where-Object { $_ -like "origin/dev=*" }).Split("=")[1]
git diff --name-only HEAD...$originDev | Set-Content -LiteralPath (Join-Path $audit "changed-files.txt")
git diff --name-only HEAD...$originDev |
  Where-Object { $_ -match '^packages/[^/]+/' -and $_ -notmatch '^packages/(console|web|stats)/' } |
  ForEach-Object { ($_ -split '/')[1] } |
  Sort-Object -Unique |
  Set-Content -LiteralPath (Join-Path $audit "changed-packages.txt")
Get-Content -LiteralPath (Join-Path $audit "changed-packages.txt")
```

Expected: an explicit package list derived from the refreshed range. Always include `core`, `opencode`, `client`, `app`, and `desktop` in validation when they exist, even if conflict resolution rather than the upstream range touches them.

- [ ] **Step 2: Record repository metadata checks**

```powershell
git diff --check
git fsck --no-progress --connectivity-only
```

Expected: both commands exit `0`. Append command, exit code, and the last relevant output line to `baseline.tsv`.

- [ ] **Step 3: Run the mandatory fork baseline checks package-by-package**

Run each command from its package directory and record pass/fail without aborting the evidence collection after the first known baseline failure:

```powershell
# packages/core
bun typecheck
bun test --only-failures

# packages/opencode
bun typecheck
bun test --timeout 30000 --only-failures
bun run test:httpapi

# packages/client
bun typecheck
bun test --timeout 5000
bun run check:generated

# packages/app
bun run typecheck
bun run typecheck:e2e
bun run test:unit
bun run test:browser

# packages/desktop
bun run typecheck
bun test
```

Expected: either a pass or a fully captured pre-existing failure for every command. Do not run a root-level test command. If a listed package script no longer exists at the refreshed tip, record `not-applicable` with the inspected `package.json` evidence rather than inventing a replacement.

- [ ] **Step 4: Add checks for every additional changed maintained package**

For each package in `changed-packages.txt` not covered above, inspect its `package.json` and run its declared `typecheck` and `test` scripts from that package. Record exact commands, exit codes, and concise failure signatures in `baseline.tsv`.

- [ ] **Step 5: Validate workflow syntax at baseline**

Inspect `.github/workflows/tauri-shell-windows.yml`, `.github/workflows/tauri-shell-macos.yml`, `.github/workflows/tauri-release.yml`, `.github/workflows/codegen-check.yml`, and `.github/workflows/app-tests.yml`. Use the repository's existing workflow linter if one is introduced by upstream; otherwise parse them with the same CI/tooling used by the repository and record that no YAML parse errors occur.

No commit is created in this task.

## Task 4: Start the merge and inventory every conflict

**Files:**

- Create: `docs/upstream-sync/2026-09-19-conflicts.md`
- Modify: paths reported by `git diff --name-only --diff-filter=U`

- [ ] **Step 1: Start a no-commit merge using the recorded upstream object ID**

```powershell
$originDev = (Get-Content -LiteralPath (Join-Path $audit "refs.txt") | Where-Object { $_ -like "origin/dev=*" }).Split("=")[1]
git merge --no-ff --no-commit $originDev
```

Expected: either a clean staged merge or a stopped merge with conflicts. Do not commit yet.

- [ ] **Step 2: Capture the conflict inventory before resolving anything**

```powershell
git diff --name-only --diff-filter=U
git status --short
```

Expected: every unresolved path is visible. Copy the list into `docs/upstream-sync/2026-09-19-conflicts.md` under one of:

- intentionally removed product;
- maintained source/config/test;
- generated artifact;
- workflow or packaging metadata.

- [ ] **Step 3: Add a ledger row for every conflict**

Each ledger row must contain:

```markdown
| Path | Class | Base intent | NextCode intent | Upstream intent | Resolution | Validation |
```

Expected: the number of ledger rows exactly matches the initial unresolved-path count. For a conflict-free merge, state that explicitly and include the zero count.

## Task 5: Preserve intentional deletions and resolve maintained conflicts

**Files:**

- Modify: `docs/upstream-sync/2026-09-19-conflicts.md`
- Modify/delete: conflict paths from Task 4

- [ ] **Step 1: Preserve removed product trees**

For conflicts under the three removed roots, keep the deletion:

```powershell
git rm -r --ignore-unmatch packages/console packages/web packages/stats
```

Expected: none of the three directories exists in the worktree or index. Record the policy decision once, but retain one ledger row per conflicted path.

- [ ] **Step 2: Review each maintained conflict as a three-way comparison**

For each maintained unresolved path:

```powershell
$conflict = "packages/example/path.ts" # set this to the exact ledger path being reviewed
git show ":1:$conflict"
git show ":2:$conflict"
git show ":3:$conflict"
```

Interpret `:1` as merge base, `:2` as NextCode/fork, and `:3` as upstream. Preserve NextCode branding, SemIf behavior, desktop packaging, and other fork-owned behavior while incorporating compatible upstream bug fixes and refactors.

Expected: the ledger explains the semantic choice. Resolve hand edits with `apply_patch`, then stage the exact `$conflict` path with `git add -- $conflict` or `git rm -- $conflict`.

- [ ] **Step 3: Handle generated conflicts at their source**

If conflicts occur in generated client or SDK outputs, resolve the source `HttpApi`, Protocol, schema, or generator input first. Do not hand-edit generated output to make the conflict disappear. Leave the generated paths for Task 6.

- [ ] **Step 4: Prove the index has no unresolved entries**

```powershell
git diff --name-only --diff-filter=U
git ls-files -u
```

Expected: both outputs are empty.

- [ ] **Step 5: Inspect the semantic merge diff before generation**

```powershell
git diff --cached --stat
git diff --cached --check
git diff --cached --name-status
```

Expected: no whitespace errors, no unexpected restoration of removed products, and no OMO implementation files.

## Task 6: Regenerate only affected contracts and lockfiles

**Files:**

- Regenerate when source contract changed: `packages/client/src/generated/**`
- Regenerate when source contract changed: `packages/client/src/generated-effect/**`
- Regenerate when legacy SDK contract changed: `packages/sdk/openapi.json`, `packages/sdk/js/src/gen/**`, `packages/sdk/js/src/v2/gen/**`
- Modify when dependency metadata changed: repository lockfile(s)

- [ ] **Step 1: Detect whether public contract sources changed**

```powershell
git diff --cached --name-only | Select-String -Pattern 'packages/(protocol|server|opencode/src/server/routes/.*/httpapi|schema)/'
```

Expected: a non-empty result requires client generation; changes affecting the legacy JavaScript SDK/OpenAPI also require the SDK generator.

- [ ] **Step 2: Regenerate the typed client when required**

From `packages/client`:

```powershell
bun run generate
bun run check:generated
```

Expected: generation succeeds and `check:generated` exits `0`. Stage the generated changes as one mechanically produced set.

- [ ] **Step 3: Regenerate the legacy JavaScript SDK when required**

From the repository root in the isolated worktree:

```powershell
bun ./packages/sdk/js/script/build.ts
```

Expected: the generator succeeds. Inspect and stage only outputs explained by the merged source contract.

- [ ] **Step 4: Update dependencies with repository-native tooling when required**

If upstream changed workspace dependency metadata, run the existing Bun install/update command used by the repository and inspect the lockfile diff. Do not manually patch a generated lockfile.

- [ ] **Step 5: Recheck the staged tree**

```powershell
git add --all
git diff --cached --check
git status --short
```

Expected: no unresolved paths or untracked implementation artifacts.

## Task 7: Run targeted and baseline-equivalent validation

**Files:**

- Create outside Git: `%TEMP%\nextcode-upstream-sync\post-merge.tsv`
- Modify: `docs/upstream-sync/2026-09-19-conflicts.md` with validation results

- [ ] **Step 1: Run focused tests for every maintained conflict**

Use the conflict ledger's validation column to run the nearest unit/service test for every maintained path before broad package suites. Record each command and result in the ledger.

- [ ] **Step 2: Repeat every baseline command exactly**

Re-run all commands from Task 3 with the same working directories and arguments, writing results to `post-merge.tsv`.

Expected: all baseline passes remain passes. A baseline failure may remain only with the same concise signature. Any new or changed failure is a regression and must be fixed or the merge aborted.

- [ ] **Step 3: Revalidate generated artifacts**

From `packages/client`:

```powershell
bun run check:generated
```

If the SDK generator ran, run it a second time and verify it produces no new diff:

```powershell
bun ./packages/sdk/js/script/build.ts
git diff --exit-code -- packages/sdk/openapi.json packages/sdk/js/src/gen packages/sdk/js/src/v2/gen
```

Expected: idempotent generation.

- [ ] **Step 4: Validate desktop and workflows**

From `packages/desktop`:

```powershell
bun run typecheck
bun run build:renderer-tauri
```

Run the package build/package configuration tests that exist at the refreshed tip, and re-parse the five workflow files from Task 3.

Expected: no new desktop or workflow regression relative to baseline.

- [ ] **Step 5: Run final structural assertions**

```powershell
@( "packages/console", "packages/web", "packages/stats" ) | ForEach-Object {
  if (Test-Path -LiteralPath $_) { throw "Removed product restored: $_" }
}
git diff --cached --check
git status --short
```

Expected: all removed roots are absent and the merge is ready to commit.

## Task 8: Create and audit the merge commit

**Files:**

- Modify: `docs/upstream-sync/2026-09-19-conflicts.md`

- [ ] **Step 1: Finish the conflict ledger**

Add the refreshed OIDs, baseline/post-merge comparison, generated commands used, and any accepted unchanged baseline failures. The document must contain no unresolved planning markers.

- [ ] **Step 2: Create the merge commit**

```powershell
git add docs/upstream-sync/2026-09-19-conflicts.md
git commit -m "chore: merge upstream dev"
```

Expected: the commit has two parents: recorded `jevcode/dev` and recorded `origin/dev`.

- [ ] **Step 3: Verify merge topology and scope**

```powershell
git show --no-patch --pretty=raw HEAD
git diff --check HEAD^1..HEAD
git diff --name-status HEAD^1..HEAD
git log --oneline --decorate -5
```

Expected: two parents, no whitespace errors, removed products remain deleted, and no native OMO implementation is present.

- [ ] **Step 4: Re-run the highest-risk smoke checks on committed `HEAD`**

At minimum run:

```powershell
# packages/opencode
bun typecheck
bun run test:httpapi

# packages/client
bun run check:generated

# packages/app
bun run typecheck
bun run typecheck:e2e

# packages/desktop
bun run typecheck
```

Expected: results match Task 7.

## Task 9: Prove source-checkout preservation and hand off the branch

**Files:**

- Read only: `%TEMP%\nextcode-upstream-sync\source-state.txt`
- Read only: `%TEMP%\nextcode-upstream-sync\source-hashes.txt`

- [ ] **Step 1: Return to the original checkout for read-only verification**

Run from `D:\Projetos\JevCode`:

```powershell
$currentState = git status --porcelain=v1 --untracked-files=all
$expectedState = Get-Content -LiteralPath (Join-Path $audit "source-state.txt")
Compare-Object $expectedState $currentState
git diff --binary -- packages/core/src/filesystem/search.ts | git hash-object --stdin
git rev-parse HEAD
```

Expected: `Compare-Object` has no output; the diff hash and `HEAD` match `source-hashes.txt`. Do not attempt to clean the nested checkout.

- [ ] **Step 2: Produce the review handoff**

Report:

- branch and worktree path;
- merge commit and both parent OIDs;
- conflict count and ledger path;
- baseline versus post-merge results;
- generated artifacts and generator commands;
- confirmation that the original checkout was unchanged.

- [ ] **Step 3: Keep OMO work separate**

Do not add OMO commits to `upstream-sync`. The native OMO implementation branch must be created from this validated merge commit after review/acceptance.
