# Native OMO and SemIf Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the approved OMO Slim core behavior into NextCode as native agents, routing, delegation, migration, observability, and end-to-end coverage, with SemIf as a non-blocking advisory router and no runtime dependency on the legacy plugin.

**Architecture:** Put stable OMO configuration, agent definitions, prompts, and routing contracts in Core. Compose the runtime implementation in `packages/opencode`: a pure strategy generator, an Effect `OmoRouter`, a shared `DelegationService` with legacy and V2 adapters, and a globally registered Core tool for V2 sessions. The V2 adapter creates child sessions through `SessionV2`, admits prompts through `SessionV2.prompt`, joins execution through `SessionV2.resume`, and uses the existing background-job registry; it never reaches into `SessionRunner`. The legacy `TaskTool` delegates through the same server service and retains its public behavior. Public status is exposed through `HttpApi`, generated clients, and the app status popover.

**Tech Stack:** TypeScript, Effect, Bun, NextCode Core/V2 sessions, legacy server runtime, SemIf/llama-server, Effect HttpApi, generated TypeScript clients/SDK, SolidJS, Playwright, Tauri desktop CI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-19-native-omo-semif-design.md`

## Global Constraints

- Begin only from the reviewed upstream-sync merge commit; use a separate short branch such as `native-omo`.
- Use `oh-my-opencode-slim` 2.2.22 at commit `3685293ae6896deca1d85a14a38ba47510a50add` only as a behavioral reference. Do not vendor it, install it automatically, or execute it through the plugin API.
- The first delivery excludes council, companion, terminal multiplexers, advanced commands/hooks, bundled skill synchronization, SmartFetch, AST-grep distribution, and automatic future OMO synchronization.
- Preserve dependency direction: Schema to Core/Protocol, Core/Protocol to Server; Client runtime never depends on Core or Server.
- Do not intercept, wrap, or reimplement `SessionV2.prompt`, `SessionExecution`, `SessionRunner`, provider streaming, durable inbox promotion, or location ownership.
- Use `ApplicationTools` to expose `omo_delegate` to V2 location registries; do not add legacy server dependencies to Core.
- Explicit routing overrides win field-by-field. SemIf scores are diagnostic ordering only, never calibrated confidence.
- Only call `SemifService.decide` after `status()` returns `ready`. Every other state falls back immediately; optional warm-up is detached.
- Keep permission denial, unknown agent, depth exhaustion, and cancellation as typed failures. No fallback may broaden permissions.
- Native background delegation is controlled by `omo.background`; it must not require `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.
- Never edit generated clients or SDK output by hand. After public `HttpApi` changes run `bun run generate` from `packages/client`, then run the legacy JS SDK generator when its OpenAPI surface changes.
- Run tests/typechecks from package directories; use `bun typecheck`, never direct `tsc`, and never run tests from repository root.

## Review Focus

1. **OMO accidentally remains a plugin:** assert that native agents/tools are present with plugins disabled and that no production code imports or loads `oh-my-opencode-slim`.
2. **SemIf blocks or destabilizes routing:** service tests cover every non-ready state, timeout, cancellation, malformed output, and missing slot with immediate deterministic fallback.
3. **Delegation bypasses session/permission invariants:** integration tests prove prompt admission, parent/child identity, depth, permission denial, cancellation, background promotion, and exact TaskTool compatibility.
4. **Migration destroys user configuration:** fixture tests cover JSON/JSONC preservation, backups, dry run, exact plugin removal, unsupported fields, and refusal to overwrite native `omo` without explicit replacement.
5. **E2E passes only under timing luck:** Playwright review requires isolated fixtures, unique user-facing locators, auto-wait/web-first assertions, no sleeps/fixed timeouts, and repeated focused runs; packaged smoke uses readiness polling rather than arbitrary delays.

---

## Task 1: Create the implementation branch and freeze the behavioral reference

**Files:**

- Create: `docs/omo/reference-2.2.22.md`
- Create: `docs/omo/port-matrix.md`

- [ ] **Step 1: Create an isolated implementation branch from the accepted sync commit**

From the synchronized worktree after Task 9 of the upstream plan:

```powershell
git status --short --branch
git switch -c native-omo
git rev-parse HEAD
```

Expected: a clean `native-omo` branch whose parent is the reviewed `chore: merge upstream dev` merge commit. If `native-omo` already exists, inspect it instead of overwriting it.

- [ ] **Step 2: Record reference provenance without adding reference source code**

Write `docs/omo/reference-2.2.22.md` with:

- npm version `2.2.22`;
- Git commit `3685293ae6896deca1d85a14a38ba47510a50add`;
- inspected upstream URLs/files and their hashes;
- the seven in-scope agent roles;
- recognized config fields and preset mappings;
- explicit list of deferred features.

Expected: the repository contains documentation/provenance only, not copied plugin package trees or an OMO dependency.

- [ ] **Step 3: Build the port matrix**

Create `docs/omo/port-matrix.md` with one row per approved behavior:

```markdown
| Behavior | Reference location | Native owner | Tests | Status |
```

Map each row to `OmoConfig`, `OmoAgents`, `OmoRouter`, `DelegationService`, `OmoDelegateTool`, migration, status/UI, or validation. Mark deferred rows `out-of-scope`, not `TODO`.

- [ ] **Step 4: Add a dependency guard assertion to the plan evidence**

```powershell
rg -n "oh-my-opencode-slim" packages --glob '!**/test/**'
```

Expected before implementation: no production runtime import. Later occurrences are allowed only in migration/conflict-detection string constants and tests, never an import/package dependency.

- [ ] **Step 5: Commit reference documentation**

```powershell
git add docs/omo/reference-2.2.22.md docs/omo/port-matrix.md
git commit -m "docs(omo): freeze slim reference"
```

## Task 2: Add the native OMO config contract and resolver

**Files:**

- Create: `packages/core/src/config/omo.ts`
- Create: `packages/core/src/omo.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/v1/config/config.ts`
- Test: `packages/core/test/omo.test.ts`
- Test: `packages/core/test/config.test.ts`

- [ ] **Step 1: Write failing schema/default tests**

In `packages/core/test/omo.test.ts`, cover:

- omitted block resolves to enabled `auto` behavior;
- `enabled: false` is the escape hatch;
- presets `auto`, `openai`, and `opencode-go` resolve deterministically;
- per-agent model/variant overrides win over preset values;
- disabled specialists are removed but `orchestrator` cannot be silently disabled while OMO is enabled;
- background policy and verification default validation;
- invalid optional fields fall back individually and return path-specific diagnostics;
- the resolved config object never contains unknown legacy fields.

Use the exact stable shape:

```ts
type OmoConfig = {
  enabled?: boolean
  preset?: "auto" | "openai" | "opencode-go"
  agents?: Record<string, { model?: string; variant?: string; permission?: Record<string, unknown> }>
  disabled_agents?: string[]
  background?: "auto" | "allow" | "deny"
  routing?: "auto" | "deterministic" | "semif"
  verification?: "none" | "tests" | "oracle" | "observer"
}
```

Run from `packages/core`:

```powershell
bun test test/omo.test.ts --only-failures
```

Expected: fail because the module and schema do not exist.

- [ ] **Step 2: Implement the self-exported config module**

In `packages/core/src/config/omo.ts`:

- start with `export * as ConfigOmo from "./omo"`;
- define Effect schemas for the stable fields;
- define agent IDs as the approved seven values;
- expose a pure `resolve(input)` returning `{ info, diagnostics }`;
- cap/sanitize diagnostics and name exact config paths;
- encode model refs using existing provider/model conventions instead of inventing a new parser.

In `packages/core/src/omo.ts`, re-export stable OMO agent IDs, verification/source types, routing request/recommendation schemas, and preset constants needed by Core and Server. Keep server services out of this file.

- [ ] **Step 3: Wire the schema into V2 and V1 config readers**

Add `omo: Schema.optional(ConfigOmo.Info)` to `Config.Info` in `packages/core/src/config.ts` and the equivalent field to `packages/core/src/v1/config/config.ts`, reusing the same schema rather than duplicating it.

Expected: both config systems read the same `omo` block from NextCode configuration files.

- [ ] **Step 4: Add default-agent resolution tests**

In `packages/core/test/config.test.ts`, prove:

- enabled OMO plus no `default_agent` resolves the native default to `orchestrator` at agent-registration time;
- an explicit `default_agent` wins;
- disabled OMO keeps the existing `build` default;
- a legacy-plugin conflict suppresses native OMO registration instead of creating duplicate IDs.

The conflict input is the exact package name `oh-my-opencode-slim`, optionally followed by an npm version such as `@2.2.22`; similarly named paths/packages do not count.

- [ ] **Step 5: Run focused tests and Core typecheck**

```powershell
bun test test/omo.test.ts test/config.test.ts --only-failures
bun typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit the config contract**

```powershell
git add packages/core/src/config/omo.ts packages/core/src/omo.ts packages/core/src/config.ts packages/core/src/v1/config/config.ts packages/core/test/omo.test.ts packages/core/test/config.test.ts
git commit -m "feat(core): add native omo config"
```

## Task 3: Implement safe one-time migration and the CLI command

**Files:**

- Create: `packages/opencode/src/omo/migrate.ts`
- Create: `packages/opencode/src/cli/cmd/omo.ts`
- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/omo/migrate.test.ts`
- Test: `packages/opencode/test/cli/omo-migrate.test.ts`

- [ ] **Step 1: Write fixture-driven migration failures first**

Create table-driven tests with isolated temp global/project config roots for:

- discovery of global and project-local `oh-my-opencode-slim.json` and `.jsonc`;
- dry run returning the normalized native block without writes;
- import of preset, preset model mappings, disabled agents, and recognized agent options;
- path-qualified unsupported-field reporting;
- exact removal of `oh-my-opencode-slim` and `oh-my-opencode-slim@2.2.22` plugin entries only;
- preservation of a similarly named plugin, URL, or local file path;
- JSONC comments and unrelated config keys preserved;
- backup created before mutation and containing exact pre-write bytes;
- refusal when native `omo` exists;
- explicit `--replace` allowing overwrite while still backing up;
- legacy files retained after successful apply;
- rollback safety when the target write fails.

Run from `packages/opencode`:

```powershell
bun test test/omo/migrate.test.ts test/cli/omo-migrate.test.ts --only-failures
```

Expected: fail because the migration and command do not exist.

- [ ] **Step 2: Implement a pure migration planner**

In `packages/opencode/src/omo/migrate.ts`, separate:

- discovery;
- legacy JSON/JSONC decode;
- normalized `ConfigOmo.Info` projection;
- unsupported path collection;
- exact plugin entry matching;
- an immutable preview object describing reads, target diff, backup path, warnings, and refusal reason.

Do not read legacy files at runtime outside this command.

- [ ] **Step 3: Implement atomic apply through structured config facilities**

Use the same `jsonc-parser` edit/write approach as `packages/opencode/src/config/config.ts` and backup behavior from `packages/opencode/src/config/tui-migrate.ts`. Apply must:

1. reread and verify the previewed source/target hashes;
2. refuse stale inputs;
3. write a timestamped recoverable backup;
4. patch only `omo` and the exact plugin array entries;
5. preserve comments/unrelated keys;
6. leave source legacy files untouched.

- [ ] **Step 4: Register `omo migrate` in the existing CLI**

In `packages/opencode/src/cli/cmd/omo.ts`, expose:

```text
omo migrate [--apply] [--replace] [--json]
```

Default is dry run. `--replace` is invalid without `--apply`. Human output lists target file, imported fields, unsupported fields, exact plugin removals, and backup path; `--json` emits the stable preview/result object.

Add `.command(OmoCommand)` in `packages/opencode/src/index.ts`. The repository's current executable remains `opencode`; the product-facing invocation is the same subcommand through the NextCode-distributed CLI. Do not broaden this task into a repository-wide executable rename.

- [ ] **Step 5: Run migration tests and typecheck**

```powershell
bun test test/omo/migrate.test.ts test/cli/omo-migrate.test.ts --only-failures
bun typecheck
```

Expected: all pass and temp fixtures prove byte-preserving backup behavior.

- [ ] **Step 6: Commit migration**

```powershell
git add packages/opencode/src/omo/migrate.ts packages/opencode/src/cli/cmd/omo.ts packages/opencode/src/index.ts packages/opencode/test/omo/migrate.test.ts packages/opencode/test/cli/omo-migrate.test.ts
git commit -m "feat(omo): migrate slim configuration"
```

## Task 4: Register native agents, prompts, permissions, and presets

**Files:**

- Create: `packages/core/src/omo/orchestrator.txt`
- Create: `packages/core/src/omo/librarian.txt`
- Create: `packages/core/src/omo/oracle.txt`
- Create: `packages/core/src/omo/designer.txt`
- Create: `packages/core/src/omo/fixer.txt`
- Create: `packages/core/src/omo/observer.txt`
- Modify: `packages/core/src/omo.ts`
- Modify: `packages/core/src/plugin/agent.ts`
- Modify: `packages/opencode/src/agent/agent.ts`
- Test: `packages/core/test/agent.test.ts`
- Test: `packages/opencode/test/agent/agent.test.ts`

- [ ] **Step 1: Add failing Core and legacy agent tests**

Prove in both registries:

- native IDs are `orchestrator`, `explore`, `librarian`, `oracle`, `designer`, `fixer`, and `observer`;
- `orchestrator` is primary; all specialists are subagents;
- `explore` reuses/refines the existing native agent rather than registering a duplicate;
- each specialist has its intended read/write/shell/web/task/visual permission envelope;
- disabled agents disappear;
- preset/per-agent model and variant resolution is identical in V1 and V2;
- explicit user agent config overrides native defaults through existing merge rules;
- enabled OMO with no explicit default selects `orchestrator`;
- disabled OMO preserves `build`;
- legacy plugin conflict suppresses all added native OMO agents and exposes the conflict diagnostic.

Run focused tests from `packages/core` and `packages/opencode`; expect them to fail before implementation.

- [ ] **Step 2: Write narrow prompts with explicit boundaries**

Port behavior from the pinned reference into the six new prompt files. Keep `explore` based on the existing prompt. Prompts must state:

- role and allowed scope;
- when to return evidence versus make changes;
- verification duties;
- no permission escalation;
- no hidden reliance on legacy plugin commands/features;
- for `orchestrator`, use `omo_delegate`, reconcile results, and perform recommended verifier follow-up before claiming completion.

Do not copy deferred council/companion/hook behaviors into prompts.

- [ ] **Step 3: Expose shared definitions from Core**

In `packages/core/src/omo.ts`, export pure agent definition builders containing prompt, mode, default permission rules, default model policy, and description. Accept resolved config as input so V1 and V2 consume the same definitions.

- [ ] **Step 4: Register in the V2 native agent plugin**

Update `packages/core/src/plugin/agent.ts` to read resolved OMO config, register definitions, refine existing `explore`, and set `orchestrator` as default only when the user has not configured a default. Keep later config plugins authoritative for user overrides.

- [ ] **Step 5: Register the same definitions in the legacy Agent service**

Update `packages/opencode/src/agent/agent.ts` to consume the shared Core builders and translate permission/model fields into the legacy shape. Do not duplicate prompt strings or preset tables.

- [ ] **Step 6: Run agent tests and typechecks**

```powershell
# packages/core
bun test test/agent.test.ts test/omo.test.ts --only-failures
bun typecheck

# packages/opencode
bun test test/agent/agent.test.ts --only-failures
bun typecheck
```

Expected: agent lists and effective permissions match in both runtimes.

- [ ] **Step 7: Commit native agents**

```powershell
git add packages/core/src/omo packages/core/src/omo.ts packages/core/src/plugin/agent.ts packages/opencode/src/agent/agent.ts packages/core/test/agent.test.ts packages/opencode/test/agent/agent.test.ts
git commit -m "feat(omo): add native agent roster"
```

## Task 5: Build the pure strategy generator and deterministic router

**Files:**

- Create: `packages/opencode/src/omo/strategy.ts`
- Create: `packages/opencode/src/omo/deterministic.ts`
- Test: `packages/opencode/test/omo/strategy.test.ts`
- Test: `packages/opencode/test/omo/deterministic.test.ts`

- [ ] **Step 1: Write failing strategy-generation tests**

Cover:

- only eligible/non-disabled agents appear;
- background options disappear when unavailable or denied;
- unavailable verification options disappear;
- semantically invalid pairs such as `observer + tests` are not produced;
- stable IDs use `agent:foreground|background:verification`;
- ordering is stable across runs;
- output is deduplicated and capped at 16;
- explicit agent/background/verification fields constrain, rather than append to, the eligible set;
- zero eligible strategies returns a typed routing error.

- [ ] **Step 2: Implement a bounded pure generator**

`strategy.ts` must have no Effect, service, model, filesystem, or global config dependency. Accept fully resolved inputs and return immutable strategy records. Apply stable priority before slicing to 16 so the cap is deterministic.

- [ ] **Step 3: Write failing deterministic classification tests**

Table-test stable task signals for:

- repository discovery -> `explore`;
- external docs/dependency research -> `librarian`;
- architecture/diagnosis/review -> `oracle`;
- visual/UI implementation -> `designer`;
- bounded code/test change -> `fixer`;
- image/PDF/visual evidence -> `observer`;
- mixed/unknown -> stable fallback order;
- background preference only for independent work;
- verification selection based on task/evidence and available mechanisms.

Tests must assert the chosen eligible strategy ID, not duplicate the scoring implementation.

- [ ] **Step 4: Implement deterministic routing**

Use bounded normalized tokens/signals from task summary/evidence, stable weighted rules, and original strategy order as the final tie-breaker. Return ranked alternatives with finite numeric scores and a sanitized fallback reason. Never use a provider/model call.

- [ ] **Step 5: Run tests and commit**

```powershell
bun test test/omo/strategy.test.ts test/omo/deterministic.test.ts --only-failures
bun typecheck
git add packages/opencode/src/omo/strategy.ts packages/opencode/src/omo/deterministic.ts packages/opencode/test/omo/strategy.test.ts packages/opencode/test/omo/deterministic.test.ts
git commit -m "feat(omo): add deterministic routing"
```

## Task 6: Integrate SemIf as a non-blocking advisory router

**Files:**

- Create: `packages/opencode/src/omo/router.ts`
- Create: `packages/opencode/src/omo/observability.ts`
- Test: `packages/opencode/test/omo/router.test.ts`

- [ ] **Step 1: Write a controlled SemIf test layer**

Use scoped Effect layers, not `globalThis` mocks. The fake service records calls and can return each lifecycle state, a chosen answer, malformed output, missing answer slots, failure, cancellation, or a never-completing decision bounded by the router timeout.

- [ ] **Step 2: Write failing state-machine tests**

Assert:

- `ready` causes exactly one `decide` call over the generated option IDs;
- all other lifecycle states cause zero `decide`/`acquire` calls and immediate deterministic output;
- `auto`/`lazy` may fork `start` only after returning/forking, never await it;
- timeout, malformed answer, missing slot, ineligible answer, ordinary SemIf error, and SemIf-only policy failure normalize as specified;
- user cancellation cancels routing work and is not converted into success;
- explicit overrides win field-by-field and source becomes `explicit` when any field is applied;
- alternatives contain eligible IDs/scores only;
- prompt/evidence content is absent from emitted metadata;
- fallback reason and summary are bounded/sanitized;
- routing duration is finite and non-negative.

- [ ] **Step 3: Implement `OmoRouter` as an Effect service**

The happy path must read:

1. resolved config;
2. eligible strategies from `strategy.ts`;
3. SemIf `status()`;
4. one `decide()` only if ready;
5. normalization/eligibility validation;
6. field-level explicit overrides;
7. structured observation record.

Use the approved `OmoRoutingRecommendation` contract from Core. If routing policy is deterministic, skip SemIf even when ready. If policy requests SemIf but it is unavailable, fall back and record the reason rather than failing the session.

- [ ] **Step 4: Implement bounded observability state**

`observability.ts` stores the most recent sanitized routing failure and emits structured logs/spans with agent, background, verification, source, overrides, alternative IDs/scores, and duration. Do not store full task prompts.

- [ ] **Step 5: Run tests and commit**

```powershell
bun test test/omo/router.test.ts test/omo/strategy.test.ts test/omo/deterministic.test.ts --only-failures
bun typecheck
git add packages/opencode/src/omo/router.ts packages/opencode/src/omo/observability.ts packages/opencode/test/omo/router.test.ts
git commit -m "feat(omo): integrate semif routing"
```

## Task 7: Extract legacy delegation into `DelegationService`

**Files:**

- Create: `packages/opencode/src/omo/delegation.ts`
- Modify: `packages/opencode/src/tool/task.ts`
- Modify: `packages/opencode/src/effect/app-runtime.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Test: `packages/opencode/test/omo/delegation-legacy.test.ts`
- Modify tests: `packages/opencode/test/tool/task.test.ts`

- [ ] **Step 1: Pin existing TaskTool behavior with characterization tests**

Before refactoring, add assertions for:

- unknown agent error;
- permission request/denial metadata;
- depth limit;
- child permission derivation and primary-tool denies;
- child reuse by `task_id`;
- parent model/variant inheritance and agent override;
- foreground output/error/cancellation;
- background start, extend, notification injection, promotion, and cancel;
- experimental flag requirement for direct legacy `TaskTool` background mode.

Run the focused test and commit only tests if needed to establish the green baseline.

- [ ] **Step 2: Define one server-side service with explicit runtime adapters**

`DelegationService.Interface` exposes:

```ts
type DelegateRequest = LegacyDelegateRequest | V2DelegateRequest
type DelegateResult = {
  sessionID: string
  state: "running" | "completed"
  text: string
  background: boolean
  downgraded?: string
  jobID?: string
}
```

The service owns common input validation, depth policy, background start/extend/wait/cancel, result normalization, and rendering. The legacy adapter owns only legacy session/prompt-specific operations. The V2 adapter is added in Task 8. Keep supporting details below the happy-path service method.

- [ ] **Step 3: Move existing legacy execution without changing behavior**

Move permission checks, ancestry calculation, session reuse/create, model/variant resolution, prompt operations, background job flow, and cancellation out of `TaskTool` into the legacy adapter. `TaskTool` remains responsible for its schema/description and converting tool context to `LegacyDelegateRequest`.

Do not change its output XML tags, metadata field names, foreground default, or experimental flag behavior.

- [ ] **Step 4: Register the service in both runtime compositions**

Add `DelegationService.node` to `packages/opencode/src/effect/app-runtime.ts` and the server `app` group in `server.ts`, with explicit dependencies on existing services. Do not instantiate a second background-job registry.

- [ ] **Step 5: Prove byte/shape compatibility**

Run:

```powershell
bun test test/tool/task.test.ts test/omo/delegation-legacy.test.ts --only-failures
bun typecheck
```

Expected: all existing TaskTool tests pass without snapshot/output updates except changes needed to assert delegation through the service.

- [ ] **Step 6: Commit the extraction**

```powershell
git add packages/opencode/src/omo/delegation.ts packages/opencode/src/tool/task.ts packages/opencode/src/effect/app-runtime.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/test/omo/delegation-legacy.test.ts packages/opencode/test/tool/task.test.ts
git commit -m "refactor(omo): extract delegation service"
```

## Task 8: Add the V2 delegation adapter without bypassing durable prompt admission

**Files:**

- Modify: `packages/core/src/session.ts`
- Modify: `packages/opencode/src/omo/delegation.ts`
- Test: `packages/core/test/session.test.ts`
- Test: `packages/opencode/test/omo/delegation-v2.test.ts`

- [ ] **Step 1: Add failing child-session identity tests**

Extend Core session tests for a child creation input that:

- requires an existing parent;
- derives the exact parent location rather than accepting a conflicting location;
- persists `parentID`, selected agent, and model;
- allows child messages/history through normal SessionV2 APIs;
- does not alter `SessionV2.prompt` or runner behavior.

Prefer a dedicated `createChild({ parentID, agent, model })` service method over widening public HTTP create input. This is an internal Core interface addition and should not change Protocol/HttpApi schemas.

- [ ] **Step 2: Implement `SessionV2.createChild`**

Use `SessionStore`/`SessionV2.get` to resolve the parent and call the same internal creation path as `create`, setting `parentID` and parent location. Do not access `SessionRunner` or `SessionExecution` directly from OMO.

- [ ] **Step 3: Write failing V2 delegation integration tests**

With isolated database, location-service map, controlled LLM, real agent registry, real permissions, and real background-job service, cover:

- child creation and exact parent relationship;
- prompt admitted with `resume: false`, followed by `SessionV2.resume` joining the drain;
- latest child assistant text/error normalization;
- explicit child reuse only when parent matches;
- model/variant override and session inheritance;
- depth enforcement across V2 parent chain;
- parent permission denial before child creation;
- abort interrupts child and cancels the job;
- background start/extend returns immediately;
- completion notification is admitted back to the parent via `SessionV2.prompt` as a bounded synthetic `<task_result>` envelope and wakes through normal admission;
- background deny/unavailable downgrades to foreground only when native OMO policy permits, with a recorded reason.

- [ ] **Step 4: Implement the V2 adapter**

The adapter sequence is fixed:

1. get parent session;
2. calculate depth;
3. assert `omo_delegate` permission for the chosen agent through the parent location's `PermissionV2` service;
4. resolve/reuse a valid child;
5. `SessionV2.prompt({ sessionID: child.id, prompt, resume: false })`;
6. foreground: `SessionV2.resume(child.id)`, then read messages;
7. background: run the same resume/read Effect in `BackgroundJob`;
8. on completion, admit the bounded result envelope to the parent with `SessionV2.prompt`.

This deliberately uses public service boundaries and never calls `SessionRunner`, model streaming, or inbox tables.

- [ ] **Step 5: Run Core and server integration tests**

```powershell
# packages/core
bun test test/session.test.ts --only-failures
bun typecheck

# packages/opencode
bun test test/omo/delegation-v2.test.ts test/omo/delegation-legacy.test.ts test/tool/task.test.ts --only-failures
bun typecheck
```

- [ ] **Step 6: Commit the V2 adapter**

```powershell
git add packages/core/src/session.ts packages/core/test/session.test.ts packages/opencode/src/omo/delegation.ts packages/opencode/test/omo/delegation-v2.test.ts
git commit -m "feat(omo): delegate through v2 sessions"
```

## Task 9: Register the native `omo_delegate` tool and verification contract

**Files:**

- Create: `packages/opencode/src/omo/delegate-tool.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Test: `packages/opencode/test/omo/delegate-tool.test.ts`
- Test: `packages/core/test/application-tools.test.ts`

- [ ] **Step 1: Write failing tool-registration tests**

Assert that:

- `omo_delegate` is present in a V2 location registry when native OMO is enabled;
- it is absent when OMO is disabled or a legacy-plugin conflict exists;
- it is an `ApplicationTools` registration, not a plugin tool;
- registration is scope-safe and does not duplicate across location rebuilds;
- materialized permissions can hide/deny it;
- it remains available when external plugins are disabled.

- [ ] **Step 2: Define the Core tool schema**

Input:

```ts
{
  description: string
  prompt: string
  evidence?: string
  agent?: OmoAgentID
  background?: boolean
  verification?: "none" | "tests" | "oracle" | "observer"
  task_id?: string
}
```

Structured output contains child/job IDs, state, selected strategy, provenance, alternatives, applied overrides, downgrade/fallback reason, and bounded result text. Mark the tool permission as `omo_delegate`.

- [ ] **Step 3: Implement route-then-delegate behavior**

The execute callback must:

1. resolve parent/location OMO config;
2. ask `OmoRouter` for the final recommendation;
3. add a bounded tests-verification instruction to the child prompt when mode is `tests`;
4. call `DelegationService` exactly once for the primary specialist;
5. return strategy metadata and result.

For `oracle` or `observer` verification, return a required follow-up recommendation in structured output. The orchestrator prompt from Task 4 must issue a second explicit `omo_delegate` call with that verifier after the primary result; the tool must not secretly start an unpermissioned second task.

- [ ] **Step 4: Register globally for V2 tool registries**

Create a global app-node layer that captures `ApplicationTools`, `SessionV2`, `LocationServiceMap`, `OmoRouter`, `DelegationService`, config, background jobs, and SemIf services, and registers the tool through `ApplicationTools.register`. Add the node to the combined server graph in `server.ts` after its dependencies.

- [ ] **Step 5: Test failure and degradation paths**

Cover SemIf fallback, field overrides, background downgrade, permission denial, unknown/disabled agent, depth failure, cancellation, foreground result, background running result, background completion admission, tests instruction, and verifier follow-up metadata.

- [ ] **Step 6: Run and commit**

```powershell
# packages/core
bun test test/application-tools.test.ts --only-failures
bun typecheck

# packages/opencode
bun test test/omo/delegate-tool.test.ts test/omo/router.test.ts test/omo/delegation-v2.test.ts --only-failures
bun typecheck

git add packages/opencode/src/omo/delegate-tool.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/test/omo/delegate-tool.test.ts packages/core/test/application-tools.test.ts
git commit -m "feat(omo): add native delegation tool"
```

## Task 10: Add public OMO status and generated clients

**Files:**

- Create: `packages/opencode/src/omo/status.ts`
- Create: `packages/opencode/src/server/routes/instance/httpapi/groups/omo.ts`
- Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/omo.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/api.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Test: `packages/opencode/test/server/httpapi-omo.test.ts`
- Generate: `packages/client/src/generated/**`
- Generate: `packages/client/src/generated-effect/**`
- Generate: `packages/sdk/openapi.json`
- Generate: `packages/sdk/js/src/gen/**`
- Generate: `packages/sdk/js/src/v2/gen/**`

- [ ] **Step 1: Write failing service and HttpApi tests**

Define the response:

```ts
{
  enabled: boolean
  preset: "auto" | "openai" | "opencode-go"
  agents: string[]
  semif: SemifStatus
  conflict: { active: boolean; plugin?: string }
  last_failure?: string
}
```

Tests cover enabled/disabled, agent filtering, each SemIf state, conflict reporting, sanitized/bounded last failure, auth behavior, and OpenAPI operation presence.

- [ ] **Step 2: Implement `OmoStatus` service**

Aggregate resolved config, native agent availability, `SemifService.status()`, exact legacy-plugin conflict, and `OmoObservability`'s last sanitized failure. Status must be read-only and must never start/download SemIf.

- [ ] **Step 3: Add the public HttpApi group**

Mirror the existing SemIf group/handler structure. Add `GET /omo/status` (or the repository's normalized group path) to `RootHttpApi`, wire handlers into `rootApiRoutes`, and provide the status service in the app graph.

- [ ] **Step 4: Run server tests before generation**

From `packages/opencode`:

```powershell
bun test test/server/httpapi-omo.test.ts --only-failures
bun run test:httpapi
bun typecheck
```

Expected: all pass; the public API exercise includes the new endpoint.

- [ ] **Step 5: Generate clients and legacy SDK**

From `packages/client`:

```powershell
bun run generate
bun run check:generated
bun test --timeout 5000
bun typecheck
```

From repository root:

```powershell
bun ./packages/sdk/js/script/build.ts
```

Run the SDK generator a second time and require no diff to prove idempotence. Never hand-edit generated output.

- [ ] **Step 6: Commit API and generated artifacts**

```powershell
git add packages/opencode/src/omo/status.ts packages/opencode/src/server/routes/instance/httpapi/groups/omo.ts packages/opencode/src/server/routes/instance/httpapi/handlers/omo.ts packages/opencode/src/server/routes/instance/httpapi/api.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/test/server/httpapi-omo.test.ts packages/client/src/generated packages/client/src/generated-effect packages/sdk/openapi.json packages/sdk/js/src/gen packages/sdk/js/src/v2/gen
git commit -m "feat(omo): expose native status"
```

## Task 11: Surface OMO status and provenance in the app

**Files:**

- Modify: `packages/app/src/components/status-popover-body.tsx`
- Modify: `packages/app/src/context/server-sync.tsx` or the current query-options owner after sync
- Modify: `packages/app/src/i18n/*.ts`
- Modify: `packages/session-ui/src/components/message-part.tsx`
- Test: `packages/app/src/components/status-popover-body.test.tsx` or nearest existing component test
- Test: `packages/session-ui/src/components/message-part.test.tsx`

- [ ] **Step 1: Write failing view-model/component tests**

Cover:

- enabled preset and available-agent count;
- SemIf ready versus deterministic fallback label;
- prominent legacy-plugin conflict with migration command;
- sanitized last failure only;
- `omo_delegate` timeline part shows specialist, foreground/background, verification, and provenance without full prompt;
- background running/completed/error states keep the exact child session identity and navigation affordance.

- [ ] **Step 2: Add an OMO query option using the generated client**

Use the generated `omo.status` client method. Scope the query key by server connection, follow existing SemIf query patterns, and never import Core/Server into the app.

- [ ] **Step 3: Add a compact OMO tab/section to the status popover**

Render enabled/preset/agent count/SemIf source/conflict/last failure. The conflict state must explain that native registration is suppressed and direct the user to `omo migrate`; it must not offer a one-click destructive migration.

- [ ] **Step 4: Render routing metadata in the existing tool timeline**

Teach `packages/session-ui/src/components/message-part.tsx` to recognize `omo_delegate` structured output and show user-visible labels. Reuse existing task/subagent navigation conventions; do not create a parallel session navigation system.

- [ ] **Step 5: Update locale catalogs and parity tests**

Add English source keys and mechanically add safe English fallback values to every `packages/app/src/i18n/*.ts` catalog required by parity. Run the repository parity test to ensure no key drift.

- [ ] **Step 6: Run frontend checks and commit**

```powershell
# packages/session-ui
bun test
bun typecheck

# packages/app
bun run test:unit
bun run test:browser
bun run typecheck
bun run typecheck:e2e

git add packages/app/src/components/status-popover-body.tsx packages/app/src/context packages/app/src/i18n packages/session-ui/src/components/message-part.tsx packages/app/src/components packages/session-ui/src/components
git commit -m "feat(app): show native omo status"
```

## Task 12: Add deterministic server integration and Playwright E2E

**Files:**

- Create: `packages/opencode/test/omo/e2e.test.ts`
- Modify: `packages/app/e2e/utils/mock-server.ts`
- Create: `packages/app/e2e/user-story/omo-routing-flow.spec.ts`
- Create: `packages/app/e2e/user-story/omo-conflict.spec.ts`

- [ ] **Step 1: Add a full deterministic server story**

Use isolated test database/directory, controlled LLM turns, controlled SemIf service, real agent registries, real `ApplicationTools`, real permissions, real `SessionV2`, and real background jobs. Cover one story each for:

- SemIf-ready foreground routing;
- unavailable SemIf deterministic foreground fallback;
- native background start, progress metadata, completion admission, and parent continuation;
- explicit override;
- legacy-plugin conflict suppressing agents/tool;
- direct legacy TaskTool behavior still working.

Assert durable parent/child session and message IDs, not only rendered strings.

- [ ] **Step 2: Extend the Playwright fixture with controlled OMO data**

Add optional OMO status, agents, `omo_delegate` tool parts, child sessions, and background transition events to `mockNextCodeServer`. Default fixture behavior must remain unchanged for existing tests.

- [ ] **Step 3: Write the user-visible routing flow**

`omo-routing-flow.spec.ts` must verify:

- orchestrator and specialists in agent selection;
- an automatic foreground delegation displayed with selected specialist and source;
- ready SemIf provenance;
- unavailable SemIf deterministic fallback;
- background running then completed state;
- child navigation preserves the exact task/session ID.

Use role/name/text locators and web-first assertions. Register any network wait before the triggering action. Do not use `waitForTimeout`, raw sleeps, arbitrary timeout increases, or CSS selectors tied to layout.

- [ ] **Step 4: Write the conflict diagnosis story**

`omo-conflict.spec.ts` opens the status popover, selects the OMO section, and asserts the legacy-plugin conflict message, suppressed native state, and migration command. Give fixture data unique names/IDs so the test cannot pass against unrelated UI.

- [ ] **Step 5: Run focused tests repeatedly**

```powershell
# packages/opencode
bun test test/omo/e2e.test.ts --only-failures

# packages/app
bun run typecheck:e2e
bun x playwright test e2e/user-story/omo-routing-flow.spec.ts e2e/user-story/omo-conflict.spec.ts --reporter=line --repeat-each=10
```

Expected: 20 deterministic Playwright executions pass without retries masking failure.

- [ ] **Step 6: Commit E2E coverage**

```powershell
git add packages/opencode/test/omo/e2e.test.ts packages/app/e2e/utils/mock-server.ts packages/app/e2e/user-story/omo-routing-flow.spec.ts packages/app/e2e/user-story/omo-conflict.spec.ts
git commit -m "test(omo): cover native routing e2e"
```

## Task 13: Add packaged desktop smoke on Windows and macOS

**Files:**

- Create: `packages/opencode/src/cli/cmd/debug/omo.ts`
- Modify: `packages/opencode/src/cli/cmd/debug/index.ts`
- Test: `packages/opencode/test/cli/debug-omo.test.ts`
- Create: `packages/desktop/scripts/omo-smoke.ts`
- Modify: `packages/desktop/package.json`
- Modify: `.github/workflows/tauri-shell-windows.yml`
- Modify: `.github/workflows/tauri-shell-macos.yml`

- [ ] **Step 1: Add a deterministic packaged-binary self-test**

Implement `debug omo-smoke --json` as a diagnostic command using the real OMO config, agent, router, delegation, session, permission, and background services with controlled in-process LLM/SemIf layers. It must perform:

- native agent discovery with external plugins disabled;
- status read;
- deterministic foreground child delegation;
- deterministic background start/completion;
- clean service disposal.

It must not download a model, contact a provider, or use production user config/data. Gate it under the existing debug command tree, not a public server endpoint.

- [ ] **Step 2: Test the self-test command from source**

From `packages/opencode`:

```powershell
bun test test/cli/debug-omo.test.ts --only-failures
bun typecheck
```

Assert stable JSON fields and nonzero exit on any missing agent, wrong parent/child identity, failed delegation, or leaked active job.

- [ ] **Step 3: Implement desktop readiness polling**

`packages/desktop/scripts/omo-smoke.ts` accepts sidecar binary path and shell log path. It:

1. invokes the packaged sidecar `debug omo-smoke --json`;
2. validates the JSON schema/results;
3. polls the launched shell/server health and `/omo/status` with a bounded deadline and short retry interval;
4. verifies native agents/status;
5. requests graceful shutdown and checks child processes exit.

Do not use a fixed sleep as the success condition.

- [ ] **Step 4: Wire Windows and macOS workflows**

Add `packages/opencode/src/omo/**`, Core OMO/session files, and the OMO workflows/scripts to path filters. After staging the built sidecar and before/alongside the shell assertions, run `bun run smoke:omo -- <binary> <log>` from `packages/desktop` on both platforms.

The deterministic smoke must set SemIf off/controlled and prove no real-model download occurs. Replace OMO-specific arbitrary waits with the polling script; existing unrelated shell timing can be refactored separately if not needed for this story.

- [ ] **Step 5: Validate workflow syntax and local platform path**

Run package typechecks/tests, parse both YAML files, and execute the smoke on the available local platform against a single-target built binary.

- [ ] **Step 6: Commit packaged smoke**

```powershell
git add packages/opencode/src/cli/cmd/debug/omo.ts packages/opencode/src/cli/cmd/debug packages/opencode/test/cli/debug-omo.test.ts packages/desktop/scripts/omo-smoke.ts packages/desktop/package.json .github/workflows/tauri-shell-windows.yml .github/workflows/tauri-shell-macos.yml
git commit -m "test(omo): add packaged desktop smoke"
```

## Task 14: Add the manual/nightly real-model SemIf workflow

**Files:**

- Create: `packages/opencode/script/omo-real-model.ts`
- Create: `.github/workflows/omo-real-model.yml`
- Test: `packages/opencode/test/omo/real-model-contract.test.ts`

- [ ] **Step 1: Define the offline contract test first**

Test request construction and response validation without a model:

- all offered answer slots map to eligible strategy IDs;
- at most 16 strategies;
- malformed/missing slot is rejected;
- scores are finite/orderable but no exact probability threshold is asserted;
- lifecycle output is sanitized.

- [ ] **Step 2: Implement the real-model probe**

The script uses the pinned SemIf manifest/runtime, starts the actual sidecar, sends representative explore/librarian/oracle/designer/fixer/observer tasks, and asserts:

- ready lifecycle;
- valid schema;
- selected strategy is eligible;
- no missing answer slots;
- clean disposal.

Do not assert identical numeric scores across platforms.

- [ ] **Step 3: Add workflow triggers and artifacts**

`omo-real-model.yml` runs on `workflow_dispatch` and a nightly schedule on the supported runner. It installs the pinned Bun, caches only verified SemIf artifacts, runs the contract test and probe, uploads sanitized logs, and fails on lifecycle/schema/eligibility errors. It must not print task prompts, secrets, or local paths.

- [ ] **Step 4: Run the offline portion and typecheck**

```powershell
bun test test/omo/real-model-contract.test.ts --only-failures
bun typecheck
```

Run the actual model probe locally only when the pinned runtime/model is available; otherwise rely on manual/nightly CI and record that distinction.

- [ ] **Step 5: Commit workflow**

```powershell
git add packages/opencode/script/omo-real-model.ts packages/opencode/test/omo/real-model-contract.test.ts .github/workflows/omo-real-model.yml
git commit -m "test(omo): validate real semif model"
```

## Task 15: Perform dedicated E2E and implementation review

**Files:**

- Create: `docs/omo/e2e-review.md`
- Modify: defects found by review only

- [ ] **Step 1: Review Playwright tests against the required checklist**

For every changed/new Playwright test, record pass/fail for:

- isolated and uniquely named fixture data;
- user-facing locators (`getByRole`, `getByLabel`, `getByText`, test IDs only when semantic roles are impossible);
- locator uniqueness;
- actionability/auto-wait reliance;
- web-first assertions;
- network wait registered before action;
- no `waitForTimeout`, sleeps, fixed-delay polling, or inflated timeouts;
- exact parent/child/task identity assertions;
- no test dependence on execution order.

- [ ] **Step 2: Search mechanically for common E2E defects**

From `packages/app`:

```powershell
rg -n "waitForTimeout|setTimeout\(|\.first\(\)|\.nth\(|timeout:\s*[1-9][0-9]{4,}" e2e/user-story/omo-*.spec.ts e2e/utils/mock-server.ts
```

Expected: every match is removed or justified in `docs/omo/e2e-review.md`; there should be no arbitrary waiting in the OMO specs.

- [ ] **Step 3: Review the five architectural failure modes**

Record direct test/file evidence for each item in the top-level Review Focus section. Specifically verify:

- plugin-disabled native operation;
- SemIf non-ready immediate fallback;
- V2 durable prompt admission and no SessionRunner import;
- migration backup/exact removal;
- repeated E2E stability.

- [ ] **Step 4: Run a security/privacy diff scan manually**

Inspect routing logs, HttpApi output, tool metadata, CI artifacts, and migration output for leaked full prompts, secrets, absolute user paths, or model credentials. Fix any leak and add a regression assertion.

- [ ] **Step 5: Commit review evidence/fixes**

```powershell
git add docs/omo/e2e-review.md
git add --update
git commit -m "test(omo): complete e2e review"
```

Because this work starts from a clean isolated branch, `git add --update` stages only tracked review fixes. Explicitly add any newly created regression test before committing.

## Task 16: Run final verification and whole-branch review

**Files:**

- Modify: `docs/omo/port-matrix.md`
- Create: `docs/omo/verification.md`

- [ ] **Step 1: Run complete affected-package verification**

```powershell
# packages/core
bun test --only-failures
bun typecheck

# packages/opencode
bun test --timeout 30000 --only-failures
bun run test:httpapi
bun typecheck

# packages/client
bun run check:generated
bun test --timeout 5000
bun typecheck

# packages/session-ui
bun test
bun typecheck

# packages/app
bun run test:unit
bun run test:browser
bun run typecheck
bun run typecheck:e2e
bun x playwright test e2e/user-story/omo-routing-flow.spec.ts e2e/user-story/omo-conflict.spec.ts --reporter=line --repeat-each=10

# packages/desktop
bun test
bun run typecheck
bun run build:renderer-tauri
```

Expected: all pass. Record command, platform, duration, and result in `docs/omo/verification.md`. Do not run tests from the repository root.

- [ ] **Step 2: Prove generators are clean and idempotent**

```powershell
# packages/client
bun run check:generated

# repository root, generator only
bun ./packages/sdk/js/script/build.ts
git diff --exit-code -- packages/client/src/generated packages/client/src/generated-effect packages/sdk/openapi.json packages/sdk/js/src/gen packages/sdk/js/src/v2/gen
```

Expected: no uncommitted generated drift.

- [ ] **Step 3: Run architectural guards**

```powershell
rg -n "from .*server|from .*opencode" packages/core/src/omo.ts packages/core/src/config/omo.ts packages/core/src/omo
rg -n "SessionRunner|SessionExecution|session_input|SessionInput\.admit" packages/opencode/src/omo
rg -n "oh-my-opencode-slim" packages --glob '!**/test/**'
rg -n "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS" packages/opencode/src/omo
```

Expected:

- no Core-to-Server/legacy runtime import;
- no OMO direct runner/inbox manipulation;
- legacy package name only in migration/conflict string matching;
- native OMO background path independent of the experimental env flag.

- [ ] **Step 4: Verify no out-of-scope feature leaked in**

Compare the branch diff with the deferred list in `port-matrix.md`. Search for council, companion, multiplexer, SmartFetch, AST-grep distribution, skill synchronization, and phase hooks. Any implementation beyond explanatory docs is removed or separately approved.

- [ ] **Step 5: Review every commit and branch diff**

```powershell
$syncMerge = git merge-base HEAD upstream-sync
git log --oneline --decorate "$syncMerge..HEAD"
git diff --stat "$syncMerge..HEAD"
git diff --check "$syncMerge..HEAD"
git status --short --branch
```

Verify `$syncMerge` equals the immutable upstream-sync OID recorded in `docs/omo/reference-2.2.22.md`. Expected: conventional commits, no whitespace errors, and a clean worktree.

- [ ] **Step 6: Complete the port matrix and verification evidence**

Every in-scope row in `docs/omo/port-matrix.md` must be `implemented` with direct test references; every deferred row remains `out-of-scope`. `docs/omo/verification.md` records packaged-smoke CI links when available and clearly labels the real-model workflow as manual/nightly rather than blocking local completion.

- [ ] **Step 7: Commit final evidence**

```powershell
git add docs/omo/port-matrix.md docs/omo/verification.md
git commit -m "docs(omo): record implementation verification"
```

- [ ] **Step 8: Prepare review handoff**

Report:

- upstream-sync base OID and native OMO branch tip;
- config/migration behavior and backup contract;
- native agent/tool registration evidence with plugins disabled;
- SemIf-ready and fallback evidence;
- legacy TaskTool compatibility evidence;
- V2 foreground/background parent-child evidence;
- generated API/client status;
- Playwright repeated-run result;
- Windows/macOS packaged-smoke status;
- manual/nightly real-model workflow status;
- deferred features unchanged.
