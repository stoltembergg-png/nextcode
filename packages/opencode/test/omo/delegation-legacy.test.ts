import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { DelegationService, type TaskPromptOps } from "@/omo/delegation"
import type { Context } from "@/tool/tool"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { SessionPrompt } from "@/session/prompt"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    Config.node,
    CrossSpawnSpawner.node,
    Database.node,
    DelegationService.node,
    EventV2Bridge.node,
    Ripgrep.node,
    RuntimeFlags.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
  ]),
)

const it = testEffect(layer)

const seed = Effect.fn("DelegationLegacyTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Pinned" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text: "delegated",
      },
    ],
  }
}

function promptOps(seen: { current?: SessionPrompt.PromptInput }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        seen.current = input
        return reply(input)
      }),
  }
}

describe("omo.delegation legacy", () => {
  it.instance("preserves foreground TaskTool delegation through the shared service", () =>
    Effect.gen(function* () {
      const delegation = yield* DelegationService.Service
      const { chat, assistant } = yield* seed()
      const seen: { current?: SessionPrompt.PromptInput } = {}
      const metadata: unknown[] = []

      const result = yield* delegation.delegate({
        kind: "legacy",
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        ask: () => Effect.void,
        metadata: (input) =>
          Effect.sync(() => {
            metadata.push(input)
          }),
        promptOps: promptOps(seen),
      })

      expect(result).toEqual({
        sessionID: result.sessionID,
        state: "completed",
        text: `<task id="${result.sessionID}" state="completed">\n<task_result>\ndelegated\n</task_result>\n</task>`,
        background: false,
      })
      expect(seen.current?.sessionID).toBe(result.sessionID)
      expect(seen.current?.variant).toBe("xhigh")
      expect(metadata).toHaveLength(1)
      expect(metadata[0]).toEqual({
        title: "inspect bug",
        metadata: {
          parentSessionId: chat.id,
          sessionId: result.sessionID,
          model: ref,
        },
      })
    }),
  )

  it.instance("keeps unknown-agent and permission failures typed", () =>
    Effect.gen(function* () {
      const delegation = yield* DelegationService.Service
      const { chat, assistant } = yield* seed()
      const request = (subagent_type: string, ask: Context["ask"] = () => Effect.void) =>
        delegation.delegate({
          kind: "legacy",
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type,
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          ask,
          metadata: () => Effect.void,
          promptOps: promptOps({}),
        })

      const unknown = yield* request("missing-agent").pipe(Effect.exit)
      expect(Exit.isFailure(unknown)).toBe(true)
      if (Exit.isFailure(unknown)) expect(String(unknown.cause)).toContain("Unknown agent type")

      const denied = yield* request("general", () =>
        Effect.sync(() => {
          throw new Error("permission denied")
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
    }),
  )
})
