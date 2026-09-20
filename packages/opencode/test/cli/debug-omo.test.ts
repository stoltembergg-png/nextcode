import { describe, expect, test } from "bun:test"
import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { agentDefinitions } from "@opencode-ai/core/omo"
import { OmoSmoke, runOmoSmoke } from "../../src/cli/cmd/debug/omo"

describe("debug omo-smoke", () => {
  test("reports deterministic native foreground and background checks", () => {
    const result = runOmoSmoke()

    expect(result).toMatchObject({
      schema: "nextcode.omo-smoke/v1",
      result: "passed",
      mode: "controlled",
      external_plugins: false,
      semif: {
        mode: "controlled",
        network: false,
        downloads: false,
      },
      checks: {
        agents: { ok: true },
        status: { ok: true, enabled: true, routing: "deterministic" },
        foreground: { ok: true, state: "completed", parent_id: "ses_omo_smoke_parent" },
        background: { ok: true, started: true, state: "completed", active_jobs: 0 },
        disposal: { ok: true, active_jobs: 0 },
      },
    })
    expect(result.checks.agents.ids).toEqual(ConfigOmo.AgentIDs)
    expect(result.checks.foreground.child_id).not.toBe(result.checks.foreground.parent_id)
    expect(result.checks.background.child_id).not.toBe(result.checks.foreground.child_id)
  })

  test("uses the native roster with external plugins disabled", () => {
    const ids = agentDefinitions(ConfigOmo.resolve({ enabled: true, disabled_agents: [] }).info).map((agent) => agent.id)

    expect(runOmoSmoke({ agents: ids }).checks.agents.ids).toEqual(ConfigOmo.AgentIDs)
  })

  test("fails instead of hiding missing native agents", () => {
    expect(() => runOmoSmoke({ agents: ConfigOmo.AgentIDs.slice(0, -1) })).toThrow(
      OmoSmoke.errors.agents,
    )
  })

  test("fails instead of accepting a mismatched parent or child", () => {
    expect(() =>
      runOmoSmoke({
        foreground: { parent_id: "ses_wrong_parent" },
      }),
    ).toThrow(OmoSmoke.errors.identity)
  })

  test("fails on delegation errors and leaked background jobs", () => {
    expect(() => runOmoSmoke({ foreground: { state: "error" } })).toThrow(OmoSmoke.errors.delegation)
    expect(() => runOmoSmoke({ disposal: { active_jobs: 1 } })).toThrow(OmoSmoke.errors.jobs)
  })
})
