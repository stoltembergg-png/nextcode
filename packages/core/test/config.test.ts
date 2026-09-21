import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("native OMO config wiring", () => {
  test("V2 and V1 readers share the same OMO schema", () => {
    const input = {
      omo: {
        preset: "openai",
        agents: { fixer: { model: "openai/gpt-5.6-luna", variant: "high" } },
      },
    } as const

    expect(Schema.decodeUnknownSync(Config.Info)(input).omo).toEqual(input.omo)
    expect(Schema.decodeUnknownSync(ConfigV1.Info)(input).omo).toEqual(input.omo)
  })

  test("enabled OMO selects orchestrator only when no explicit default exists", () => {
    expect(ConfigOmo.resolveDefaultAgent({ omo: { enabled: true } })).toMatchObject({
      id: "orchestrator",
      native: true,
    })
    expect(ConfigOmo.resolveDefaultAgent({ omo: { enabled: true }, default_agent: "reviewer" })).toMatchObject({
      id: "reviewer",
      native: false,
    })
    expect(ConfigOmo.resolveDefaultAgent({ omo: { enabled: false } })).toMatchObject({
      id: "build",
      native: false,
    })
  })

  test("exact legacy plugin conflict suppresses native default registration", () => {
    expect(
      ConfigOmo.resolveDefaultAgent({ omo: { enabled: true }, plugins: ["oh-my-opencode-slim@2.2.22"] }),
    ).toMatchObject({ id: "build", native: false, conflict: true })
    expect(
      ConfigOmo.resolveDefaultAgent({
        omo: { enabled: true },
        plugins: ["./oh-my-opencode-slim", "https://example.test/oh-my-opencode-slim", "my-oh-my-opencode-slim"],
      }),
    ).toMatchObject({ id: "orchestrator", native: true, conflict: false })
  })
})
