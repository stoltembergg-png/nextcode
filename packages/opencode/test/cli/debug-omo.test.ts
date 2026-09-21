import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { agentDefinitions } from "@opencode-ai/core/omo"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Global } from "@opencode-ai/core/global"
import { Effect, Exit } from "effect"
import { OmoSmoke, runOmoSmoke, runOmoSmokeServices } from "../../src/cli/cmd/debug/omo"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"

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
    const ids = agentDefinitions(ConfigOmo.resolve({ enabled: true, disabled_agents: [] }).info).map(
      (agent) => agent.id,
    )

    expect(runOmoSmoke({ agents: ids }).checks.agents.ids).toEqual(ConfigOmo.AgentIDs)
  })

  test("fails instead of hiding missing native agents", () => {
    expect(() => runOmoSmoke({ agents: ConfigOmo.AgentIDs.slice(0, -1) })).toThrow(OmoSmoke.errors.agents)
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

  test("exercises the native service graph offline within a bounded scope", async () => {
    const environmentKeys = [
      "APPDATA",
      "HOME",
      "LOCALAPPDATA",
      "USERPROFILE",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_DB",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_PURE",
      "OPENCODE_TEST_HOME",
      "SEMIF_MODE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ] as const
    const globalPathKeys = ["data", "cache", "config", "state", "tmp", "bin", "log", "repos"] as const
    const before = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
    const beforePaths = Object.fromEntries(globalPathKeys.map((key) => [key, Global.Path[key]]))
    const sentinel = await mkdtemp(path.join(tmpdir(), "opencode-omo-sentinel-"))
    const sentinelEnvironmentKeys = [
      "APPDATA",
      "HOME",
      "LOCALAPPDATA",
      "USERPROFILE",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_TEST_HOME",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ] as const
    try {
      for (const key of sentinelEnvironmentKeys) process.env[key] = sentinel
      for (const key of globalPathKeys) Global.Path[key] = sentinel
      const sentinelBefore = await readdir(sentinel)
      const directory = process.cwd()
      const instance: InstanceContext = {
        directory,
        worktree: directory,
        project: {
          id: ProjectV2.ID.make("global"),
          worktree: directory,
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }
      const exit = await Effect.runPromiseExit(
        runOmoSmokeServices().pipe(Effect.provideService(InstanceRef, instance), Effect.timeout("15 seconds")),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toMatchObject({
          result: "passed",
          execution: "v2-services",
          semif: { network: false, downloads: false },
          checks: {
            foreground: { state: "completed" },
            background: { state: "completed", active_jobs: 0 },
            disposal: { services_disposed: true },
          },
        })
      }
      expect((await readdir(sentinel)).toSorted()).toEqual(sentinelBefore.toSorted())
    } finally {
      for (const key of globalPathKeys) Global.Path[key] = beforePaths[key]
      for (const key of environmentKeys) {
        const value = before[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(sentinel, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 })
    }
    for (const key of environmentKeys) expect(process.env[key]).toBe(before[key])
    for (const key of globalPathKeys) expect(Global.Path[key]).toBe(beforePaths[key])
  })
})
