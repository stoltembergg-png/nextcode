# Native OMO verification record

Review date: 2026-09-20

Platform: Windows, PowerShell, Bun 1.3.14 (x64)

Branch: `native-omo`

Native branch tip at evidence capture: `d03b990017` (the evidence document and
port-matrix update are the following documentation-only commit).

Upstream-sync base: `4084bc57bdc0b331fbce30a7d563ddb93ef4272c` (`chore: merge upstream dev`)

The upstream source refs used by the merge were `origin/dev` at
`ebb7b76eca82342642c78645109e865614533827` and `jevcode/dev` at
`3f685f566a67da85b77c375dcd4508c096559da3`. The verification commands below
were run from their package directories; no tests were run from the repository
root.

## Affected-package results

The following records combine the final branch checks with the focused evidence
attached to Tasks 1–15. A `pass` is not a claim that unrelated baseline suites
are clean.

| Package or surface | Exact command | Result |
| --- | --- | --- |
| Core | `packages/core: bun typecheck` | Pass. |
| Core baseline tests | `packages/core: bun test --only-failures` | One known Windows quoting failure remains; this is a pre-existing platform-sensitive failure, not an OMO assertion failure. |
| OpenCode | `packages/opencode: bun typecheck` | Pass. |
| Focused OMO tests | `packages/opencode: bun test test/omo test/cli/debug-omo.test.ts` | Focused OMO evidence passed across the task runs: config/agent, strategy/router/deterministic, migration, legacy/V2 delegation, delegate tool, server-story, real-model contract, and packaged smoke. The packaged smoke regression file is 6/6. |
| OpenCode full baseline | `packages/opencode: bun test --timeout 30000 --only-failures` | 3,659 pass, 58 skip, 1 todo, 76 known failures in Windows, fixture, and UI-sensitive baseline cases. This is recorded, not waived as a clean full-suite result. |
| HTTP API | `packages/opencode: bun run test:httpapi` | 209 pass, 5 expected missing baseline cases. The five missing harness cases predate the OMO status route. |
| Client generated surface | `packages/client: bun run check:generated` | Pass; generated client output is clean. |
| Client tests | `packages/client: bun test --timeout 5000` | Pass. |
| Client types | `packages/client: bun typecheck` | Pass. |
| Session UI | `packages/session-ui: bun test` | Pass; the OMO message-part coverage is 10/10. |
| Session UI types | `packages/session-ui: bun typecheck` | Pass. |
| App unit/browser coverage | `packages/app: bun run test:unit`; `packages/app: bun run test:browser` | Affected OMO status/reducer coverage is 8/8; the recorded browser run passed. |
| App typecheck | `packages/app: bun run typecheck` | Pass. |
| App E2E typecheck | `packages/app: bun run typecheck:e2e` | Pass. |
| OMO Playwright stories | `packages/app: bun x playwright test e2e/user-story/omo-routing-flow.spec.ts e2e/user-story/omo-conflict.spec.ts --reporter=line --repeat-each=10` | 20/20 story runs across ten repetitions, with isolated fixtures, exact child identity, conflict guidance, and no arbitrary waits. See [e2e-review.md](e2e-review.md). |
| Desktop types | `packages/desktop: bun run typecheck` | Pass. |
| Desktop renderer | `packages/desktop: bun run build:renderer-tauri` | Pass. |
| Desktop tests | `packages/desktop: bun test` | Known environment failure while loading `node:sqlite`; this remains a baseline/runtime limitation. |
| Controlled packaged smoke | `packages/opencode: bun run src/index.ts --pure debug omo-smoke --json` with SemIf disabled and isolated config/data/state directories | Pass on Windows: native agents discovered, foreground and background V2 services completed, active jobs returned to zero, and disposal evidence was true. No real-model download occurred. |

## Workflow and architecture guards

The three workflow files were parsed successfully during the workflow review:

```text
.github/workflows/tauri-shell-windows.yml
.github/workflows/tauri-shell-macos.yml
.github/workflows/omo-real-model.yml
```

The bounded architectural searches were run exactly as follows:

```text
rg -n "from .*server|from .*opencode" packages/core/src/omo.ts packages/core/src/config/omo.ts packages/core/src/omo
rg -n "SessionRunner|SessionExecution|session_input|SessionInput\.admit" packages/opencode/src/omo
rg -n "oh-my-opencode-slim" packages --glob '!**/test/**'
rg -n "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS" packages/opencode/src/omo
```

Results:

- Core OMO has no Server or legacy-runtime import.
- The native OMO directory has no direct `SessionRunner`, `SessionExecution`,
  inbox-table, or `SessionInput.admit` orchestration.
- The legacy package name is limited to migration/conflict matching and related
  compatibility boundaries; it is not a runtime dependency or plugin install.
- Native background delegation has no dependency on
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.

## Generated artifacts and repository integrity

The public OMO status contract was generated through the repository generators,
not by editing generated files. The recorded idempotence checks are:

```text
packages/client: bun run check:generated
repository root: bun ./packages/sdk/js/script/build.ts
repository root: git diff --exit-code -- packages/client/src/generated packages/client/src/generated-effect packages/sdk/openapi.json packages/sdk/js/src/gen packages/sdk/js/src/v2/gen
```

The client check, legacy SDK generator, and generated-artifact diff were clean
after the API work. The final Task 16 changes are documentation-only and do not
alter generated output.

The final documentation check is:

```text
git diff --check
```

It passes for the evidence changes. The upstream merge and generated metadata
checks were also reviewed with `git diff --check` and repository metadata
validation; no whitespace or object-integrity issue was found.

## SemIf real-model boundary

`packages/opencode/test/omo/real-model-contract.test.ts` verifies the offline
contract: eligible slots, the 16-option bound, malformed/missing/ineligible
answers, finite diagnostic scores, and sanitized lifecycle output.

The actual pinned SemIf runtime/model workflow in
`.github/workflows/omo-real-model.yml` is deliberately **manual/nightly**. It
uses the verified pinned runtime and model on its supported runner, while the
ordinary CI and local smoke path use controlled/offline SemIf behavior. A real
model probe was not claimed as a local blocking pass because the pinned model
artifacts are not present in this Windows worktree. The workflow is the required
execution path for that evidence and must remain redaction-safe for prompts,
secrets, and local paths.

## Scope boundary

All in-scope rows in [port-matrix.md](port-matrix.md) are marked `implemented`
only where a direct test or verification reference is present. The nine
deferred rows remain `out-of-scope`: council orchestration, desktop companion,
terminal multiplexer, interview/advanced runtime commands, prompt-transform
hooks, bundled skill synchronization, SmartFetch, AST-grep distribution, and
automatic synchronization with future OMO Slim releases.
