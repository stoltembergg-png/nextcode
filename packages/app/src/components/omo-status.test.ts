import { describe, expect, test } from "bun:test"
import type { OmoStatus } from "@opencode-ai/sdk/v2/client"
import { omoStatusView } from "./omo-status"

const semif = (status: OmoStatus["semif"]["status"]): OmoStatus["semif"] => ({
  status,
  mode: "auto",
  download: "auto",
  backend: "cpu",
  backendRequested: "auto",
  backendFallback: false,
  systemRuntimeMissing: false,
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices: [],
})

const status = (overrides: Partial<OmoStatus> = {}): OmoStatus => ({
  enabled: true,
  preset: "opencode-go",
  agents: ["orchestrator", "fixer"],
  semif: semif("ready"),
  conflict: { active: false },
  ...overrides,
})

describe("omoStatusView", () => {
  test("shows the enabled preset, native agent count, and SemIf source", () => {
    expect(omoStatusView({ status: status() })).toEqual({
      state: "ready",
      preset: "opencode-go",
      agentCount: 2,
      source: "semif",
    })
  })

  test("labels a non-ready SemIf state as deterministic fallback", () => {
    expect(omoStatusView({ status: status({ semif: semif("failed") }) })).toMatchObject({
      state: "fallback",
      source: "deterministic",
    })
  })

  test("prioritizes legacy plugin conflicts and keeps the migration command informational", () => {
    expect(
      omoStatusView({
        status: status({ agents: [], conflict: { active: true, plugin: "oh-my-opencode-slim" } }),
      }),
    ).toMatchObject({ state: "conflict", plugin: "oh-my-opencode-slim", agentCount: 0 })
  })

  test("surfaces only the sanitized server-provided failure", () => {
    expect(omoStatusView({ status: status({ last_failure: "[path] request failed" }) })).toMatchObject({
      state: "ready",
      failure: "[path] request failed",
    })
  })
})
