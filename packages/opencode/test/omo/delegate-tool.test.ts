import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Config } from "@/config/config"
import { DelegationService } from "@/omo/delegation"
import { OmoDelegateTool, nativeOmoAvailable, name, tool } from "@/omo/delegate-tool"
import { OmoRouter } from "@/omo/router"
import type { OmoRoutingRecommendation } from "@opencode-ai/core/omo"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses_omo_delegate_tool")
const agent = AgentV2.ID.make("orchestrator")
const assistantMessageID = SessionMessage.ID.make("msg_omo_delegate_tool")

const registryLayer = AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node]), [
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])

const it = testEffect(registryLayer)

const recommendation = {
  agent: "fixer" as const,
  background: false,
  verification: "tests" as const,
  source: "deterministic" as const,
  alternatives: [{ id: "fixer:foreground:tests", score: 1 }],
  fallbackReason: "semif unavailable",
}

const config = TestConfig.make({
  get: () => Effect.succeed({ omo: { enabled: true }, plugin: [] }),
})

function runtime(options?: {
  readonly recommendation?: OmoRoutingRecommendation
  readonly result?: Partial<DelegationService.DelegateResult>
  readonly config?: Config.Interface
  readonly delegate?: DelegationService.Interface["delegate"]
}) {
  const calls: DelegationService.DelegateRequest[] = []
  const router: OmoRouter.Interface = {
    route: () => Effect.succeed(options?.recommendation ?? recommendation),
    recommend: () => Effect.succeed(options?.recommendation ?? recommendation),
  }
  const delegation: DelegationService.Interface = {
    delegate:
      options?.delegate ??
      ((request) => {
        calls.push(request)
        return Effect.succeed({
          sessionID: SessionSchema.ID.make("ses_child_omo_delegate"),
          state: "completed" as const,
          text: "validated child result",
          background: false,
          ...options?.result,
        })
      }),
  }
  return { tool: tool({ config: options?.config ?? config, router, delegation }), calls, router, delegation }
}

type ConfigInfo = ReturnType<Config.Interface["get"]> extends Effect.Effect<infer A, infer _E, infer _R> ? A : never

function registrationLayer(input: Pick<ConfigInfo, "omo" | "plugin">) {
  const current = runtime()
  return AppNodeBuilder.build(LayerNode.group([OmoDelegateTool.node, ApplicationTools.node]), [
    [
      Config.node,
      TestConfig.layer({
        get: () => Effect.succeed(input),
        getGlobal: () => Effect.succeed(input),
      }),
    ],
    [OmoRouter.node, Layer.succeed(OmoRouter.Service, current.router)],
    [DelegationService.node, Layer.succeed(DelegationService.Service, current.delegation)],
  ])
}

const enabledRegistration = testEffect(registrationLayer({ omo: { enabled: true }, plugin: [] }))
const disabledRegistration = testEffect(registrationLayer({ omo: { enabled: false }, plugin: [] }))
const conflictedRegistration = testEffect(
  registrationLayer({ omo: { enabled: true }, plugin: ["oh-my-opencode-slim@2.2.22"] }),
)

function call(input: Record<string, unknown>) {
  return {
    sessionID,
    agent,
    assistantMessageID,
    call: { type: "tool-call" as const, id: "call-omo-delegate", name, input },
  }
}

describe("native omo_delegate tool", () => {
  enabledRegistration.effect("registers once in the global carrier for V2 location registries", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      expect([...applications.entries().keys()]).toEqual([name])
      expect(applications.entries().get(name)?.tool).toBeDefined()
    }),
  )

  disabledRegistration.effect("does not register when native OMO is disabled", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      expect(applications.entries().has(name)).toBe(false)
    }),
  )

  conflictedRegistration.effect("does not register when the legacy plugin is active", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      expect(applications.entries().has(name)).toBe(false)
    }),
  )

  it.effect("registers as an ApplicationTools entry and executes exactly one primary delegation", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const current = runtime()

      yield* applications.register({ [name]: current.tool })
      expect([...applications.entries().keys()]).toEqual([name])
      expect((yield* registry.materialize()).definitions.map((item) => item.name)).toEqual([name])

      const result = yield* (yield* registry.materialize()).settle(
        call({ description: "Fix parser", prompt: "Implement the parser fix." }),
      )

      expect(result.result).toEqual({ type: "text", value: "validated child result" })
      expect(result.output?.structured).toMatchObject({
        child_id: "ses_child_omo_delegate",
        state: "completed",
        agent: "fixer",
        source: "deterministic",
        verification: "tests",
        fallback_reason: "semif unavailable",
      })
      expect(current.calls).toHaveLength(1)
      expect(current.calls[0]).toMatchObject({
        kind: "v2",
        agent: "fixer",
        prompt: expect.stringContaining("Verification requirement"),
      })
    }),
  )

  it.effect("returns verifier follow-up metadata without secretly delegating twice", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const current = runtime({
        recommendation: {
          ...recommendation,
          verification: "oracle",
          source: "semif",
          fallbackReason: undefined,
        },
      })

      yield* applications.register({ [name]: current.tool })
      const result = yield* (yield* registry.materialize()).settle(
        call({ description: "Review parser", prompt: "Inspect the parser change." }),
      )

      expect(current.calls).toHaveLength(1)
      expect(result.output?.structured).toMatchObject({
        follow_up: {
          required: true,
          agent: "oracle",
          verification: "oracle",
        },
      })
      expect(result.output?.structured).not.toHaveProperty("follow_up.child_id")
    }),
  )

  it.effect("preserves background running and downgrade metadata", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const current = runtime({
        recommendation: { ...recommendation, background: true },
        result: {
          state: "running",
          background: true,
          jobID: "job_omo_delegate",
          text: "background started",
        },
      })

      yield* applications.register({ [name]: current.tool })
      const result = yield* (yield* registry.materialize()).settle(
        call({ description: "Run checks", prompt: "Run the checks.", background: true }),
      )

      expect(result.output?.structured).toMatchObject({
        job_id: "job_omo_delegate",
        state: "running",
        background: true,
      })
    }),
  )

  it.effect("aborts the primary delegation when the tool execution is cancelled", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const entered = yield* Deferred.make<void>()
      const signals: AbortSignal[] = []
      const current = runtime({
        delegate: (request) => {
          if (request.kind === "v2") signals.push(request.abort)
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never as Effect.Effect<DelegationService.DelegateResult, never, never>),
          )
        },
      })

      yield* applications.register({ [name]: current.tool })
      const fiber = yield* (yield* registry.materialize())
        .settle(call({ description: "Cancel work", prompt: "Work until cancelled." }))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)

      expect(signals).toHaveLength(1)
      expect(signals[0]?.aborted).toBe(true)
    }),
  )

  it.effect("hides the ApplicationTools registration when the permission is denied", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const current = runtime()
      yield* applications.register({ [name]: current.tool })

      expect(
        (yield* registry.materialize([{ action: "omo_delegate", resource: "*", effect: "deny" }])).definitions,
      ).toEqual([])
    }),
  )
})

describe("native OMO tool availability", () => {
  test("requires native OMO and rejects the exact legacy plugin", () => {
    expect(nativeOmoAvailable({ omo: { enabled: true }, plugin: [] })).toBe(true)
    expect(nativeOmoAvailable({ omo: { enabled: false }, plugin: [] })).toBe(false)
    expect(nativeOmoAvailable({ omo: { enabled: true }, plugin: ["oh-my-opencode-slim@2.2.22"] })).toBe(false)
    expect(nativeOmoAvailable({ omo: { enabled: true }, plugin: ["other-plugin@1.0.0"] })).toBe(true)
  })
})

describe("native OMO tool schema", () => {
  test("keeps bounded input fields and explicit verifier values", () => {
    expect(
      Schema.decodeUnknownSync(OmoDelegateTool.Input)({
        description: "d",
        prompt: "p",
        agent: "fixer",
        verification: "observer",
      }),
    ).toMatchObject({ agent: "fixer", verification: "observer" })
  })
})
