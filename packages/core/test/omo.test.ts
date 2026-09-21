import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigOmo } from "@opencode-ai/core/config/omo"

const decode = Schema.decodeUnknownSync(ConfigOmo.Info)

describe("ConfigOmo", () => {
  test("resolves omitted configuration to enabled auto behavior", () => {
    const result = ConfigOmo.resolve({})

    expect(result.diagnostics).toEqual([])
    expect(result.info.enabled).toBe(true)
    expect(result.info.preset).toBe("auto")
    expect(result.info.background).toBe("auto")
    expect(result.info.routing).toBe("auto")
    expect(result.info.verification).toBe("none")
    expect(Object.keys(result.info.agents)).toEqual([
      "orchestrator",
      "explore",
      "librarian",
      "oracle",
      "designer",
      "fixer",
    ])
    expect(result.info.agents.observer).toBeUndefined()
  })

  test("keeps disabled OMO as an explicit escape hatch", () => {
    const result = ConfigOmo.resolve({ enabled: false })

    expect(result.info.enabled).toBe(false)
    expect(result.info.agents).toEqual({})
    expect(result.info.preset).toBe("auto")
  })

  test("resolves the approved presets deterministically", () => {
    expect(ConfigOmo.resolve({ preset: "openai" }).info.agents).toMatchObject({
      orchestrator: { model: "openai/gpt-5.6-terra", variant: "high" },
      oracle: { model: "openai/gpt-5.6-sol", variant: "high" },
      librarian: { model: "openai/gpt-5.6-luna", variant: "low" },
      explore: { model: "openai/gpt-5.6-luna", variant: "low" },
      designer: { model: "openai/gpt-5.6-luna", variant: "medium" },
      fixer: { model: "openai/gpt-5.6-luna", variant: "high" },
    })
    expect(ConfigOmo.resolve({ preset: "opencode-go" }).info.agents).toMatchObject({
      orchestrator: { model: "opencode-go/minimax-m3", variant: "thinking" },
      oracle: { model: "opencode-go/qwen3.7-max", variant: "max" },
      librarian: { model: "opencode-go/deepseek-v4-flash", variant: "high" },
      explore: { model: "opencode-go/deepseek-v4-flash", variant: "high" },
      designer: { model: "opencode-go/kimi-k2.7-code" },
      fixer: { model: "opencode-go/deepseek-v4-flash", variant: "high" },
    })
    expect(ConfigOmo.resolve({ preset: "opencode-go" }).info.agents.observer).toBeUndefined()
    expect(ConfigOmo.resolve({ preset: "opencode-go", disabled_agents: [] }).info.agents.observer).toEqual({
      model: "opencode-go/mimo-v2.5",
    })
  })

  test("applies per-agent model, variant, and permission overrides field by field", () => {
    const result = ConfigOmo.resolve({
      preset: "openai",
      agents: {
        fixer: { model: "anthropic/claude-sonnet-4-6", permission: { edit: "deny" } },
        designer: { variant: "low" },
      },
    })

    expect(result.info.agents.fixer).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      variant: "high",
      permission: { edit: "deny" },
    })
    expect(result.info.agents.designer).toEqual({ model: "openai/gpt-5.6-luna", variant: "low" })
  })

  test("removes disabled specialists but protects orchestrator", () => {
    const result = ConfigOmo.resolve({ disabled_agents: ["librarian", "orchestrator"] })

    expect(result.info.agents.librarian).toBeUndefined()
    expect(result.info.agents.orchestrator).toBeDefined()
    expect(result.info.disabled_agents).toEqual(["librarian"])
    expect(result.diagnostics).toContainEqual({
      kind: "invalid",
      path: ["disabled_agents", "orchestrator"],
      message: "orchestrator cannot be disabled while OMO is enabled",
    })
  })

  test("keeps observer opt-in when only another specialist is disabled", () => {
    expect(ConfigOmo.resolve({ disabled_agents: ["librarian"] }).info.agents.observer).toBeUndefined()
    expect(ConfigOmo.resolve({ disabled_agents: [] }).info.agents.observer).toBeDefined()
    expect(ConfigOmo.resolve({ agents: { observer: {} } }).info.agents.observer).toBeDefined()
  })

  test("validates background and verification defaults", () => {
    expect(ConfigOmo.resolve({ background: "allow", verification: "observer" }).info).toMatchObject({
      background: "allow",
      verification: "observer",
    })
    expect(ConfigOmo.resolve({ background: "invalid", verification: "invalid" }).info).toMatchObject({
      background: "auto",
      verification: "none",
    })
  })

  test("falls back optional fields individually and reports bounded paths", () => {
    const result = ConfigOmo.resolve({
      preset: "invalid",
      background: "invalid",
      routing: "semif",
      verification: "invalid",
      agents: {
        fixer: { model: "not-a-model", variant: 1, permission: "invalid" },
        unknown: { model: "openai/gpt-5.6-luna" },
      },
      disabled_agents: ["librarian", "unknown", 1],
    })

    expect(result.info.preset).toBe("auto")
    expect(result.info.background).toBe("auto")
    expect(result.info.routing).toBe("semif")
    expect(result.info.verification).toBe("none")
    expect(result.info.agents.fixer).toEqual({})
    expect(result.info.agents.unknown).toBeUndefined()
    expect(result.info.agents.librarian).toBeUndefined()
    expect(result.diagnostics.map((item) => item.path)).toEqual([
      ["preset"],
      ["background"],
      ["verification"],
      ["agents", "fixer", "model"],
      ["agents", "fixer", "variant"],
      ["agents", "fixer", "permission"],
      ["agents", "unknown"],
      ["disabled_agents", "unknown"],
      ["disabled_agents", "2"],
    ])
  })

  test("does not retain unknown legacy fields in the resolved object", () => {
    const result = ConfigOmo.resolve({ preset: "auto", backgroundJobs: { enabled: true }, council: {} })

    expect(result.info).toEqual({
      enabled: true,
      preset: "auto",
      agents: {
        orchestrator: {},
        explore: {},
        librarian: {},
        oracle: {},
        designer: {},
        fixer: {},
      },
      disabled_agents: [],
      background: "auto",
      routing: "auto",
      verification: "none",
    })
  })

  test("caps and sanitizes diagnostics", () => {
    const longName = `unknown-${"x".repeat(512)}`
    const result = ConfigOmo.resolve({
      agents: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`${longName}-${index}`, { model: "invalid-model" }]),
      ),
      disabled_agents: Array.from({ length: 40 }, (_, index) => `disabled-${index}`),
    })

    expect(result.diagnostics).toHaveLength(32)
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.path.every((part) => part.length <= 64)).toBe(true)
      expect(diagnostic.message.length).toBeLessThanOrEqual(160)
    }
    expect(JSON.stringify(result.diagnostics)).not.toContain("x".repeat(128))
  })

  test("decodes the stable schema while ignoring unrelated legacy keys", () => {
    expect(
      decode({
        enabled: true,
        preset: "auto",
        agents: { fixer: { model: "openai/gpt-5.6-luna" } },
        backgroundJobs: { enabled: true },
      }),
    ).toEqual({
      enabled: true,
      preset: "auto",
      agents: { fixer: { model: "openai/gpt-5.6-luna" } },
    })
  })

  test("resolves the default agent and exact legacy plugin conflict", () => {
    expect(ConfigOmo.resolveDefaultAgent({ omo: { enabled: true } })).toEqual({
      id: "orchestrator",
      native: true,
      conflict: false,
    })
    expect(ConfigOmo.resolveDefaultAgent({ default_agent: "reviewer", omo: { enabled: true } })).toEqual({
      id: "reviewer",
      native: false,
      conflict: false,
    })
    expect(ConfigOmo.resolveDefaultAgent({ omo: { enabled: false } })).toEqual({
      id: "build",
      native: false,
      conflict: false,
    })
    expect(
      ConfigOmo.resolveDefaultAgent({ omo: { enabled: true }, plugins: ["oh-my-opencode-slim@2.2.22"] }),
    ).toEqual({ id: "build", native: false, conflict: true })
    expect(ConfigOmo.hasLegacyPluginConflict(["./oh-my-opencode-slim", "https://example.test/oh-my-opencode-slim"])).toBe(
      false,
    )
    expect(ConfigOmo.hasLegacyPluginConflict(["oh-my-opencode-slim@2.2.22"])).toBe(true)
  })
})
