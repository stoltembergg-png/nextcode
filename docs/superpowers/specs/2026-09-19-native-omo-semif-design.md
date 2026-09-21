# Native OMO and SemIf Integration Design

**Date:** 2026-09-19
**Status:** Approved in conversation
**Dependency:** `2026-09-19-upstream-sync-design.md`
**Reference implementation:** `oh-my-opencode-slim` 2.2.22, Git commit `3685293ae6896deca1d85a14a38ba47510a50add`

## Intent

Make the core orchestration behavior of OMO Slim a native NextCode capability rather than an embedded or automatically installed plugin. Reuse NextCode's agents, sessions, permissions, tools, and background-job runtime. Integrate the native SemIf service as an advisory routing engine with deterministic degradation. Validate the result from unit level through browser and packaged-desktop smoke tests.

## First-Delivery Scope

The first delivery includes:

- native orchestrator and specialist agents;
- agent prompts, permissions, model mappings, and presets;
- native foreground and background delegation;
- advisory SemIf routing;
- deterministic routing fallback;
- one-time migration from OMO Slim configuration;
- structured routing observability and a server status surface;
- deterministic server and Playwright coverage;
- packaged desktop smoke coverage on Windows and macOS;
- a manual or nightly real-model SemIf workflow.

The following OMO Slim features are intentionally deferred:

- council;
- companion;
- terminal multiplexers;
- interview and advanced runtime commands;
- prompt-transform hooks and phase reminders;
- bundled skill installation and synchronization;
- SmartFetch;
- AST-grep distribution;
- automatic synchronization with future OMO Slim releases.

Future OMO work is evaluated manually against the pinned reference. NextCode owns the native implementation after this port.

## Architectural Approach

Port behavior, not the plugin architecture. Do not vendor the plugin as an internal package and do not boot it through the plugin API.

The implementation has five native units:

### OmoConfig

Defines and resolves the global `omo` configuration block. The stable native surface covers:

- enabled state;
- active preset;
- per-agent model and variant overrides;
- disabled specialists;
- background policy;
- routing policy;
- verification defaults.

The default preset is `auto`: the orchestrator inherits the selected session model and specialists inherit user overrides or native defaults. Optional `openai` and `opencode-go` presets provide ready-made mappings without making those providers mandatory.

When OMO is enabled and the user has not configured `default_agent`, `orchestrator` becomes the default primary agent. The existing `build` agent remains available. `omo.enabled = false` is the escape hatch.

### OmoAgents

Registers these agents through the existing native Agent service:

- `orchestrator`: primary decomposition, delegation, and reconciliation;
- `explore`: reuse and refine the existing native repository exploration agent;
- `librarian`: external documentation and dependency research;
- `oracle`: architecture, diagnosis, and review;
- `designer`: UI/UX and visual implementation;
- `fixer`: bounded implementation and test execution;
- `observer`: image, PDF, and visual-evidence analysis.

Each specialist has a narrow prompt and permission set. User configuration may override models and permissions through existing native mechanisms. The implementation must not create duplicate agent IDs when migrated configuration or a legacy plugin is present.

### OmoRouter

An Effect service receives a bounded routing request containing:

- task summary and evidence;
- eligible agents;
- whether background execution is allowed;
- available verification mechanisms;
- explicit user or orchestrator overrides.

It generates at most 16 eligible strategy options. Each option combines an agent, execution mode, and verification mode, for example `fixer + foreground + tests` or `designer + background + observer`.

When SemIf is ready, the router performs one semantic decision over those strategies. Its output is normalized to:

```ts
type OmoRoutingRecommendation = {
  agent: string
  background: boolean
  verification: "none" | "tests" | "oracle" | "observer"
  source: "semif" | "deterministic" | "explicit"
  alternatives: Array<{
    id: string
    score: number
  }>
  fallbackReason?: string
}
```

SemIf probabilities are uncalibrated decision scores. They order alternatives and support diagnostics; they are not treated as confidence guarantees or compared with a universal acceptance threshold.

Explicit overrides win field by field. The router fills only omitted decisions and records the applied overrides.

### DelegationService

Extract the reusable execution path currently owned by `TaskTool` into a native service. It owns:

- permission checks;
- subagent depth enforcement;
- child-session creation and reuse;
- model and variant resolution;
- foreground execution;
- background job start, extension, promotion, and notification;
- cancellation and result normalization.

`TaskTool` continues to expose explicit low-level delegation and remains backward compatible.

### OmoDelegateTool

The orchestrator uses a native OMO delegation tool with optional agent, execution-mode, and verification overrides. It calls `OmoRouter`, then `DelegationService`. This adapter must not duplicate session or background-job logic.

The tool returns structured metadata containing the final strategy and its provenance. The orchestrator remains the final decision-maker because it can override any recommendation.

## Session and Dependency Boundaries

OMO operates above durable prompt admission. It must not intercept or reimplement `SessionV2.prompt`, `SessionExecution`, `SessionRunner`, model streaming, or durable inbox promotion.

It uses existing child sessions and background jobs. A routing decision has no durable execution identity of its own. Durable session and message records remain the source of truth.

Runtime dependency direction remains intact. Native OMO code may consume existing Core and Protocol contracts from the server/runtime side; it must not introduce Core dependencies on Server or legacy plugin runtime code.

## SemIf Behavior

SemIf is advisory and never a single point of failure.

- `ready`: evaluate the generated strategy options.
- `downloading`, `verifying`, `starting`, `offline`, `disabled`, `unsupported`, or `failed`: use deterministic routing immediately.
- `auto` or `lazy` mode may trigger SemIf preparation in the background, but routing never waits for acquisition or startup.
- timeout, cancellation, malformed output, missing answer slots, or an ineligible chosen strategy activate deterministic routing.

The deterministic router uses the same eligible strategy list and stable task signals. It must be pure, testable, and independent of model or provider availability.

SemIf failure does not fail the user session. Permission denial and user cancellation remain explicit failures and are never bypassed.

## Background Execution

Native OMO background delegation is controlled by `omo` configuration. It does not require `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.

If background execution is disabled or unavailable, the same delegation runs in foreground and records the downgrade reason. The existing depth limit, cancellation chain, permission derivation, and result injection semantics remain authoritative.

## Configuration Migration

Migration is explicit and one-time:

```text
nextcode omo migrate
nextcode omo migrate --apply
```

The default command is a dry run. It discovers supported global and project-local `oh-my-opencode-slim.json` or `.jsonc` files and reports the normalized native result without writing.

`--apply`:

- imports active preset, preset model mappings, disabled agents, and recognized agent options;
- creates a recoverable backup before modifying the global NextCode configuration;
- writes only the native `omo` block;
- removes only an exact `oh-my-opencode-slim` package entry from the plugin list;
- leaves legacy configuration files in place for recovery;
- lists every unsupported field;
- refuses to overwrite an existing native `omo` block unless the user supplies an explicit replacement option.

Migration must use the repository's structured config-writing facilities so comments and unrelated settings are preserved where supported.

The runtime never continuously reads OMO Slim configuration files. If the legacy plugin and native OMO are both active, NextCode reports the conflict and suppresses duplicate native agent registration until the user resolves it.

## Error Handling

- Invalid optional config fields fall back individually and produce path-specific diagnostics.
- An unavailable configured model falls back to session inheritance and records the reason.
- SemIf errors degrade to deterministic routing.
- Background unavailability degrades to foreground execution.
- Unknown explicit agents, denied permissions, exceeded depth, and cancellation remain typed failures.
- No recovery path silently expands permissions or retries state-changing delegation.

## Observability

Every OMO delegation records:

- selected agent;
- execution and verification modes;
- source: `semif`, `deterministic`, or `explicit`;
- applied overrides;
- sanitized fallback reason;
- ranked alternative IDs and scores;
- routing duration.

Do not duplicate the full task prompt in routing metadata. Persist only identifiers, a bounded sanitized summary where needed, and the decision record.

A native server status surface reports:

- OMO enabled state;
- active preset;
- available agents;
- SemIf lifecycle state;
- legacy-plugin conflict state;
- the last sanitized routing failure.

Any public Protocol or Server `HttpApi` change requires client generation from `packages/client`; generated sources are never edited manually.

## Testing Strategy

### Unit and Service Tests

Cover:

- config defaults and partial-invalid-field diagnostics;
- preset and per-agent override resolution;
- strategy generation and the 16-option limit;
- deterministic routing for each supported task class;
- SemIf normalization, invalid option handling, missing slots, timeout, and cancellation;
- field-level explicit overrides;
- model and background degradation;
- migration dry run, apply, backup, conflict refusal, exact plugin removal, and unsupported-field reporting.

Prefer real pure implementations and scoped Effect test layers over global mocks.

### Integration Tests

Exercise the real agent, session, permission, background-job, and tool services with isolated test databases and directories. Cover foreground completion, background notification, extension/resume, cancellation, depth limits, permission denial, result metadata, and legacy `TaskTool` compatibility.

Cover the status `HttpApi` and generated client contract when the public surface changes.

### Playwright E2E

Use deterministic server fixtures and controlled SemIf states. Cover:

- orchestrator and specialist visibility;
- an automatically routed foreground delegation;
- background progress and final result;
- SemIf-ready provenance;
- SemIf-unavailable deterministic fallback;
- legacy-plugin conflict diagnosis;
- exact task and session identity through the UI.

All changed E2E tests undergo a dedicated review for isolated data, unique user-facing locators, Playwright auto-waiting, web-first assertions, and absence of sleeps or fixed timeouts. Run the new focused suite repeatedly to expose flakiness.

### Desktop and Real-Model Validation

PR CI builds or exercises packaged desktop smoke paths on Windows and macOS using deterministic SemIf control. The smoke verifies boot, native-agent discovery, status availability, delegation, and clean shutdown without downloading the real model.

A manual or nightly workflow vendors the pinned `llama-server` and model, starts the actual sidecar, performs representative routing decisions, and validates schema, lifecycle, eligible output, and absence of missing slots. It does not require numerically identical scores across platforms.

## Rollout Order

1. Complete and validate the upstream sync in its own branch.
2. Add native config and migration.
3. Add native agents, prompts, permissions, and presets.
4. Add strategy generation, SemIf routing, and deterministic fallback.
5. Extract delegation and add the OMO delegation tool.
6. Add status API and routing observability.
7. Add integration, Playwright, and packaged desktop coverage.
8. Add the manual or nightly real-model workflow.
9. Perform a final E2E implementation review and whole-branch review.

## Acceptance Criteria

- NextCode provides the selected OMO core behavior without installing or loading `oh-my-opencode-slim`.
- The orchestrator and specialists are native agents.
- Existing explicit `TaskTool` delegation remains compatible.
- Native foreground and background delegation work without the experimental environment variable.
- Ready SemIf influences strategy and produces an auditable decision.
- Unavailable SemIf never blocks or fails delegation.
- Legacy config migration has preview, backup, exact plugin removal, and complete unsupported-field reporting.
- Legacy plugin conflict cannot register duplicate agents or tools.
- No OMO path bypasses prompt admission, permissions, depth limits, cancellation, or session ownership.
- Applicable typechecks, package tests, generated-client checks, Playwright tests, desktop smoke tests, and the real-model workflow pass in their intended environments.
