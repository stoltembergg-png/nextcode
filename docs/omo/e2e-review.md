# OMO E2E and implementation review

Review date: 2026-09-20

Branch: `native-omo`
Scope: the native OMO routing and conflict stories added in Task 12, plus
their server fixtures and the runtime boundaries exercised by those stories.

## Playwright checklist

| Check | `omo-routing-flow.spec.ts` | `omo-conflict.spec.ts` | Evidence |
| --- | --- | --- | --- |
| Isolated, uniquely named fixture data | pass | pass | Dedicated directory, project, session, message, child, and call IDs per story. |
| User-facing locators | pass | pass | `getByRole` is used for actionable controls; OMO status containers use exact `data-component` selectors because they have no semantic role. |
| Locator uniqueness | pass | pass | Exact tab names and exact status attributes are used; cards include agent/state identity. |
| Actionability and auto-wait | pass | pass | Actions are followed by web-first assertions; no manual polling is used. |
| Web-first assertions | pass | pass | Assertions use `toBeVisible`, `toHaveAttribute`, `toContainText`, and `toHaveURL`. |
| Network wait before action | pass | pass | The fixture is installed before `goto`; the mock server owns deterministic responses. |
| No arbitrary waits or inflated timeouts | pass | pass | No `waitForTimeout`, sleep, fixed-delay polling, or per-test timeout appears in either OMO spec. |
| Exact parent/child/task identity | pass | pass | The routing story verifies the exact child href and URL; metadata includes the exact child ID. |
| No execution-order dependency | pass | pass | Each test creates its own mock server and local-storage state; no shared mutable fixture is used. |

The stories are `packages/app/e2e/user-story/omo-routing-flow.spec.ts` and
`packages/app/e2e/user-story/omo-conflict.spec.ts`.

## Mechanical search

The review command was run from `packages/app`:

```text
rg -n "waitForTimeout|setTimeout\(|\.first\(\)|\.nth\(\)|timeout:\s*[1-9][0-9]{4,}" \
  e2e/user-story/omo-*.spec.ts e2e/utils/mock-server.ts
```

Results were limited to three `setTimeout` calls in
`e2e/utils/mock-server.ts`. Each is guarded by the fixture's optional
`messageDelay` setting and simulates server transport latency. Neither OMO
story enables that setting, and no arbitrary wait occurs in an OMO spec.
There were no `waitForTimeout`, `.first()`, `.nth()`, or inflated timeout
matches in the OMO stories.

The two stories passed ten times each in the repeated run (ten repetitions of
both stories), including the exact child navigation and conflict-state
assertions.

## Architectural review focus

| Failure mode | Result | Direct evidence |
| --- | --- | --- |
| Native operation with the legacy plugin disabled | pass | `packages/opencode/src/omo/delegate-tool.ts` gates native registration on native config and exact legacy conflict detection; Task 13 packaged smoke reports native agents and no external plugin. |
| SemIf non-ready fallback is immediate and deterministic | pass | `packages/opencode/src/omo/router.ts` selects the deterministic strategy when SemIf is unavailable; `packages/opencode/test/omo/router.test.ts` covers unavailable, timeout, cancellation, malformed, missing-slot, and ineligible answers. |
| V2 durable prompt admission without a `SessionRunner` bridge | pass | `packages/opencode/src/omo/delegation.ts` calls `SessionV2.prompt(..., { resume: false })` and resumes through the V2 execution service; no `SessionRunner` import exists under `packages/opencode/src/omo`. |
| Migration backup and exact plugin removal | pass | `packages/opencode/src/omo/migrate.ts` creates an exact-byte backup before atomic replacement and removes only the exact `oh-my-opencode-slim` entry; migration tests cover similar paths and refusal cases. |
| Repeated E2E stability | pass | Both OMO stories passed 20/20 across ten repetitions with isolated fixtures and no order dependence. |

## Security and privacy scan

The review inspected routing metadata, the OMO status route, delegate-tool
metadata, migration diagnostics, CI smoke output, and the packaged smoke
report. Full prompts are not copied into routing metadata or status output;
model credentials and authorization headers are not serialized; absolute
workspace paths are not returned by the OMO status contract. CI and smoke
reports contain bounded IDs, states, and failure categories only. The real
model workflow is separately required to redact prompts, secrets, and local
paths before artifact upload.

No additional defect or regression test was required by this review.
