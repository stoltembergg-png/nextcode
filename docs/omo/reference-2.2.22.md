# OMO Slim behavioral reference

This document freezes the external behavioral reference used for the native
NextCode OMO port. It is provenance and mapping evidence only. The reference
package is not vendored, installed, loaded, or executed by NextCode.

## Snapshot identity

| Field | Value | Evidence |
| --- | --- | --- |
| npm package | `oh-my-opencode-slim@2.2.22` | [npm registry metadata](https://registry.npmjs.org/oh-my-opencode-slim/2.2.22) |
| npm `gitHead` | `3685293ae6896deca1d85a14a38ba47510a50add` | npm registry `gitHead`; [GitHub commit](https://github.com/alvinunreal/oh-my-opencode-slim/commit/3685293ae6896deca1d85a14a38ba47510a50add) |
| upstream repository | `https://github.com/alvinunreal/oh-my-opencode-slim` | npm `repository.url` and package metadata |
| commit subject/date | `2.2.22`, 2026-09-19 20:55:52 UTC | GitHub commit API response for the pinned commit |
| npm tarball SHA-1 | `566ddd7310daf108781c1aafec970434a6aea89f` | npm registry `dist.shasum` |
| npm tarball integrity | `sha512-Rgbq8Ozl9xobZfg+/4iBmD3Ltl1UZd6Yc7mK25IBaMrXsm5SiffDCVeoum/el5z9WR3/ejux9eVlMHs2RCYeLg==` | npm registry `dist.integrity` |
| tarball inventory | 240 files, 6,366,528 unpacked bytes | npm registry `dist.fileCount`/`dist.unpackedSize` |

The native implementation starts from the accepted synchronized NextCode commit
`4084bc57bdc0b331fbce30a7d563ddb93ef4272c` (`chore: merge upstream dev`). That
OID is recorded here so final verification can prove the native branch has not
silently moved its upstream base.

## Inspection method and source hashes

The audit used the npm metadata endpoint, the GitHub commit/tree API, and the
raw files at the pinned commit. The hashes below are Git blob SHA-1 values from
the immutable GitHub tree; they identify the exact files inspected and avoid
confusing a later `main`/`dev` revision with this reference.

| Inspected file | URL at pinned commit | Git blob SHA-1 |
| --- | --- | --- |
| `package.json` | [package manifest](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/package.json) | `4d388dc427fe3d261d6c0115a8c6804f405e7082` |
| `oh-my-opencode-slim.schema.json` | [configuration schema](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/oh-my-opencode-slim.schema.json) | `10ba517261bf4a43afdfe29ffdd1369e2cc5ae8d` |
| `src/config/constants.ts` | [agent constants](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/config/constants.ts) | `7a7973bae0cc31a338d4eb6b9e5df5abae044734` |
| `src/config/schema.ts` | [runtime schema](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/config/schema.ts) | `622edaaee27bd0083de845d7251281242266bea1` |
| `src/config/runtime.ts` | [runtime resolver](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/config/runtime.ts) | `d5dabcca500b3be8c360b33c0c3ea870138209cc` |
| `src/agents/index.ts` | [agent registration](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/index.ts) | `847b580da50f650efcdda74b68726a883caed942` |
| `src/agents/orchestrator.ts` | [orchestrator definition](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/orchestrator.ts) | `43c7b1ee76b9e85bd1f0a8d489d14ae01107bc9f` |
| `src/agents/explorer.ts` | [explorer definition](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/explorer.ts) | `8af21f9ea7bc2221b6decb9de1304b7eada06620` |
| `src/agents/librarian.ts` | [librarian definition](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/librarian.ts) | `c655b15af19157a6d616ad665dad933362133a4e` |
| `src/agents/oracle.ts` | [oracle definition](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/oracle.ts) | `27a90f2c2d785fe5a5c37f7101505a33f4451b75` |
| `src/agents/designer.ts` | [designer definition](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/designer.ts) | `b0d4e1e7537d34022c8e198c4d58a89b2c6a914d` |
| `src/agents/fixer.ts` | [fixer definition](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/fixer.ts) | `f7395db7bcd0869bc4db5f3149d6f0f563345249` |
| `src/agents/observer.ts` | [observer definition](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/src/agents/observer.ts) | `0b7405fa8ee637015e31d373a5e39386bdfb3c5f` |
| `docs/openai-preset.md` | [OpenAI preset](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/docs/openai-preset.md) | `09be37dc81588686cb503c11cf5b356d42264225` |
| `docs/opencode-go-preset.md` | [OpenCode Go preset](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/docs/opencode-go-preset.md) | `50064701e4399e2d7dcb6f3167e3d32034e8ec83` |
| `docs/opencode-zen-free-preset.md` | [OpenCode Zen Free preset](https://github.com/alvinunreal/oh-my-opencode-slim/blob/3685293ae6896deca1d85a14a38ba47510a50add/docs/opencode-zen-free-preset.md) | `abf60f1c88f74ec299b9fd89c7c159e744de54f3` |

The package manifest confirms this is a plugin package (`main: dist/index.js`,
plugin exports, and the `oh-my-opencode-slim` executable). That packaging fact
is intentionally not carried into NextCode: native OMO has no package entry,
plugin loader, or dependency on the reference package.

## In-scope roles

The approved port has seven native role IDs. The reference calls the repository
exploration role `explorer`; its constants also define the compatibility alias
`explore -> explorer`. NextCode exposes the approved stable ID `explore` while
preserving that behavioral identity. The reference's `council` and dynamic
`councillor` roles are not part of this first delivery.

| Approved role | Reference evidence | Behavior frozen for the native port | Native owner |
| --- | --- | --- | --- |
| `orchestrator` | `src/agents/orchestrator.ts`, `src/agents/index.ts` | Decomposes work, chooses lanes, delegates, tracks child work, reconciles results, and verifies. It is the primary agent, not the implementation fallback. | `OmoAgents` |
| `explore` | `src/agents/explorer.ts`; alias in `src/config/constants.ts` | Fast, read-only repository navigation and pattern discovery; returns paths and concise findings. | `OmoAgents` |
| `librarian` | `src/agents/librarian.ts` | External documentation, official-source lookup, GitHub examples, and evidence-backed dependency research. | `OmoAgents` |
| `oracle` | `src/agents/oracle.ts` | Read-only architecture advice, root-cause diagnosis, simplification, and code review. | `OmoAgents` |
| `designer` | `src/agents/designer.ts` | UI/UX design and review, responsive composition, and visual polish while respecting the host design system. | `OmoAgents` |
| `fixer` | `src/agents/fixer.ts` | Bounded implementation and assigned validation after the orchestrator supplies context; no independent research or delegation. | `OmoAgents` |
| `observer` | `src/agents/observer.ts`; disabled by default in `src/config/constants.ts` | Read-only image, screenshot, PDF, and diagram interpretation, returning structured observations rather than raw bytes. | `OmoAgents` |

All role prompts remain NextCode-owned. The table freezes behavior and
responsibility boundaries; it does not authorize copying reference source.

## Recognized reference configuration

The reference JSON schema exposes the following top-level areas: `preset`,
`setDefaultAgent`, `agents`, `presets`, `disabled_agents`, `backgroundJobs`,
`fallback`, `image_routing`, `acpAgents`, `webfetch`, `multiplexer`, `council`,
`companion`, `interview`, `compactSidebar`, `autoUpdate`,
`stripOrchestratorModel`, `disabled_mcps`, `disabled_skills`, and
`disabled_tools`. The native contract deliberately accepts a smaller, stable
surface; migration reports every recognized-but-unported field rather than
silently dropping it.

| Reference field | Meaning observed at the pinned snapshot | Native treatment |
| --- | --- | --- |
| `preset` | Selects the active named preset. | Port to `omo.preset` for `auto`, `openai`, or `opencode-go`; unknown/custom names produce a path-specific migration diagnostic. |
| `presets.<name>.<agent>.model` | A string or ordered model chain for a role. | Port the selected role's model to `omo.agents.<id>.model`; native resolution keeps provider/model syntax and does not invent a parser. Ordered fallback chains are not copied into the stable first-delivery contract. |
| `presets.<name>.<agent>.variant` | Provider/model variant associated with a role. | Port to `omo.agents.<id>.variant`. A per-agent native override wins over the preset. |
| `agents.<agent>.model` / `variant` | Root agent override merged with preset values. | Port to the same native per-agent override; explicit native values win field-by-field. Reference aliases are normalized before matching. |
| `agents.<agent>.inheritModelFrom` | Explicitly inherits from `session` or `orchestrator`. | Recognized for migration diagnostics and native model resolution where supported; no hidden reference fallback is introduced. |
| `disabled_agents` | Global disabled-role list; `orchestrator` and `councillor` are protected in the reference. | Port specialist disables to `omo.disabled_agents`; native OMO refuses to silently disable `orchestrator` while enabled. |
| `setDefaultAgent` | Controls whether the plugin sets the host default to the orchestrator. | Translate to native default-agent resolution: an enabled OMO block selects `orchestrator` only when the user has not explicitly chosen `default_agent`. |
| `permission` | Tool-level allow/ask/deny rules on an agent. | Port to `omo.agents.<id>.permission` and apply through NextCode's existing permission service. No permission broadening is implied. |
| `prompt` / `orchestratorPrompt` | Role prompt replacement and short dispatch guidance. | Re-express in native `OmoAgents` prompts and orchestrator metadata; migration reports inline values that cannot be represented without changing semantics. |
| `skills`, `skills_add`, `skills_remove`, `skills_include_local`, `mcps` | Skill/MCP selection and generated permission gates. | Existing NextCode skills/MCP controls remain authoritative. Bundled skill installation/synchronization is explicitly out of scope. |
| `options`, `temperature`, `displayName`, `color`, `description` | Provider options and presentation metadata. | Recognize safe agent options where the native agent contract supports them; do not copy unknown provider options into Core configuration. Presentation is owned by native agents/UI. |
| `backgroundJobs` | Session retention, board injection, wake, timeout, and concurrency controls. | Native OMO uses its own `omo.background` policy and existing background-job runtime; reference-specific tuning keys are not imported. |
| `fallback` | Reference foreground model failover and retry budget. | Native OMO uses deterministic routing and existing provider/session fallback; reference-only retry keys are out of scope. |
| `image_routing` | Chooses direct image handling or observer routing. | Native `verification: "observer"` and the observer role express the approved behavior; reference-specific routing switches are not copied. |
| `council`, `companion`, `interview`, `multiplexer` | Additional reference products and runtime surfaces. | `out-of-scope`; migration reports these paths and leaves source files untouched. |

The native stable configuration shape is intentionally limited to:

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

## Approved preset mappings

The following model/variant mappings are transcribed from the pinned preset
documents. They are defaults, not availability guarantees; an unavailable
model falls back to session inheritance with a diagnostic. Explicit user
overrides win field-by-field.

| Preset | Agent | Model | Variant | Native status |
| --- | --- | --- | --- | --- |
| `openai` | `orchestrator` | `openai/gpt-5.6-terra` | `high` | approved |
| `openai` | `oracle` | `openai/gpt-5.6-sol` | `high` | approved |
| `openai` | `librarian` | `openai/gpt-5.6-luna` | `low` | approved |
| `openai` | `explore` (reference `explorer`) | `openai/gpt-5.6-luna` | `low` | approved |
| `openai` | `designer` | `openai/gpt-5.6-luna` | `medium` | approved |
| `openai` | `fixer` | `openai/gpt-5.6-luna` | `high` | approved |
| `openai` | `observer` | — | — | session inheritance when explicitly enabled; the reference leaves it disabled by default |
| `opencode-go` | `orchestrator` | `opencode-go/minimax-m3` | `thinking` | approved |
| `opencode-go` | `oracle` | `opencode-go/qwen3.7-max` | `max` | approved |
| `opencode-go` | `librarian` | `opencode-go/deepseek-v4-flash` | `high` | approved; reference also grants `context7` and `gh_grep` |
| `opencode-go` | `explore` (reference `explorer`) | `opencode-go/deepseek-v4-flash` | `high` | approved |
| `opencode-go` | `designer` | `opencode-go/kimi-k2.7-code` | — | approved |
| `opencode-go` | `fixer` | `opencode-go/deepseek-v4-flash` | `high` | approved |
| `opencode-go` | `observer` | `opencode-go/mimo-v2.5` | — | model mapping approved; native registration remains disabled until the user explicitly opts `observer` in through OMO configuration |
| `auto` | all seven roles | session model unless overridden | session/provider value | approved native default; not a reference fixed-model preset |

The pinned reference documents that an `opencode-go` installation may write
`disabled_agents: []` to opt the otherwise-disabled `observer` role in. Native
NextCode keeps that decision explicit: selecting the preset alone never
registers `observer`; an OMO configuration change must opt it in. This avoids a
surprising vision-model/provider requirement during a preset switch.

`opencode-zen-free` is present in the reference repository but is not one of
the approved native presets for this delivery. Custom reference presets,
multi-model chains, council model maps, and runtime preset switching are also
not silently imported; they remain migration diagnostics or deferred behavior.

## Deferred reference features

The following remain explicitly `out-of-scope` for this port and must not be
reintroduced by implementation work:

- council and councillor consensus orchestration;
- desktop companion integration;
- terminal multiplexers;
- interview and advanced runtime commands;
- prompt-transform hooks and phase reminders;
- bundled skill installation and synchronization;
- SmartFetch;
- AST-grep distribution;
- automatic synchronization with future OMO Slim releases.

Future changes are evaluated manually against this pinned snapshot. NextCode
owns the native implementation after this freeze.

## Dependency guard evidence

The required pre-implementation guard was run from the repository root:

```text
rg -n "oh-my-opencode-slim" packages --glob '!**/test/**'
```

Result: no matches. The literal may appear later only in migration/conflict
detection string constants and tests; it must never become a production import,
package dependency, plugin loader call, or runtime execution path.
