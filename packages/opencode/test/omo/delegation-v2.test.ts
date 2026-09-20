import { afterEach, describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { Node } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Deferred, Layer, LayerMap, Effect, Exit, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { DelegationService } from "@/omo/delegation"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Project } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const location = Location.Ref.make({ directory: AbsolutePath.make("/omo-delegation") })
const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const baseModel = ModelV2.Ref.make({ providerID, id: modelID })
const model = ModelV2.Ref.make({ providerID, id: modelID, variant: ModelV2.VariantID.make("fast") })

let permissionDenied = false
let backgroundPolicy: "auto" | "deny" = "auto"
let maxDepth = 2
let resumeEffect: Effect.Effect<void> = Effect.void
const resumed: SessionV2.ID[] = []
const interrupted: SessionV2.ID[] = []
const assertions: PermissionV2.AssertInput[] = []

const agentInfo = (id: AgentV2.ID) => {
  return {
    ...AgentV2.Info.empty(id),
    mode: id === AgentV2.ID.make("orchestrator") ? ("primary" as const) : ("subagent" as const),
    permissions: [{ action: "omo_delegate" as const, resource: "*" as const, effect: "allow" as const }],
  }
}

const agents = new Map(["orchestrator", "fixer", "oracle"].map((id) => [AgentV2.ID.make(id), agentInfo(AgentV2.ID.make(id))]))
const agentService = AgentV2.Service.of({
  transform: () => Effect.succeed({ dispose: Effect.void }),
  reload: () => Effect.void,
  get: (id) => Effect.succeed(agents.get(id)),
  default: () => Effect.succeed(agents.get(AgentV2.ID.make("orchestrator"))),
  resolve: (id) => Effect.succeed(id ? agents.get(AgentV2.ID.make(id)) : agents.get(AgentV2.ID.make("orchestrator"))),
  select: (id) => Effect.succeed({ id: id ? AgentV2.ID.make(id) : AgentV2.ID.make("orchestrator"), info: id ? agents.get(AgentV2.ID.make(id)) : agents.get(AgentV2.ID.make("orchestrator")) }),
  all: () => Effect.succeed([...agents.values()]),
})

const permissionService = PermissionV2.Service.of({
  assert: (input) =>
    Effect.gen(function* () {
      assertions.push(input)
      if (permissionDenied) return yield* Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
    }),
  ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" as const }),
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
})

const locationServices = Layer.mergeAll(
  Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: location.directory,
      project: { id: ProjectV2.ID.global, directory: location.directory },
    }),
  ),
  Layer.succeed(AgentV2.Service, agentService),
  Layer.succeed(PermissionV2.Service, permissionService),
) as unknown as Layer.Layer<LocationServices>

const locationMap = Node.makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make(() => locationServices, { idleTimeToLive: "1 minute" }),
  ),
  deps: [],
})

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: (sessionID) => Effect.sync(() => resumed.push(sessionID)).pipe(Effect.andThen(resumeEffect)),
    wake: () => Effect.void,
    interrupt: (sessionID) => Effect.sync(() => interrupted.push(sessionID)),
  }),
)

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    Config.node,
    CrossSpawnSpawner.node,
    Database.node,
    DelegationService.node,
    EventV2.node,
    EventV2Bridge.node,
    LocationServiceMap.node,
    Ripgrep.node,
    RuntimeFlags.node,
    Session.node,
    SessionExecution.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    SessionStore.node,
    SessionV2.node,
  ]),
  [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ subagent_depth: maxDepth, omo: { background: backgroundPolicy } }) })],
    [LocationServiceMap.node, locationMap],
    [ProjectV2.node, projects],
    [SessionExecution.node, execution],
  ],
)

const it = testEffect(layer)

afterEach(() => {
  permissionDenied = false
  backgroundPolicy = "auto"
  maxDepth = 2
  resumeEffect = Effect.void
  resumed.length = 0
  interrupted.length = 0
  assertions.length = 0
})

const parent = Effect.fn("DelegationV2Test.parent")(function* (agent: AgentV2.ID = AgentV2.ID.make("orchestrator")) {
  const sessions = yield* SessionV2.Service
  return yield* sessions.create({ location, agent })
})

const request = (sessionID: SessionV2.ID, input: Partial<DelegationService.V2DelegateRequest> = {}) => ({
  kind: "v2" as const,
  description: "Inspect the focused change",
  prompt: "Read the parser and report the result.",
  sessionID,
  agent: "fixer",
  abort: new AbortController().signal,
  ...input,
})

describe("native OMO V2 delegation", () => {
  it.live("creates a location-inheriting child and admits its prompt before resuming", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const delegation = yield* DelegationService.Service
      const root = yield* parent()
      const result = yield* delegation.delegate(request(root.id, { model: baseModel, variant: "fast" }))
      const child = yield* sessions.get(result.sessionID)

      expect(result.state).toBe("completed")
      expect(result.background).toBe(false)
      expect(child.parentID).toBe(root.id)
      expect(child.location).toEqual(root.location)
      expect(child.agent).toBe(AgentV2.ID.make("fixer"))
      expect(child.model).toEqual(model)
      expect(resumed).toEqual([child.id])
      expect(assertions).toMatchObject([{ sessionID: root.id, action: "omo_delegate", resources: ["fixer"] }])
      const admitted = yield* sessions.history({ sessionID: child.id, limit: 20 })
      expect(admitted.events.some((event) => event.type === "session.next.prompt.admitted")).toBe(true)
    }),
  )

  it.live("reuses a child only when its parent matches", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const delegation = yield* DelegationService.Service
      const first = yield* parent()
      const second = yield* parent()
      const child = yield* sessions.createChild({ parentID: first.id, agent: AgentV2.ID.make("fixer"), model })

      const exit = yield* delegation.delegate(request(second.id, { task_id: child.id })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("different parent")
      expect(yield* sessions.get(child.id)).toEqual(child)
    }),
  )

  it.live("enforces depth and checks parent permission before creating a child", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const delegation = yield* DelegationService.Service
      const root = yield* parent()
      permissionDenied = true
      const denied = yield* delegation.delegate(request(root.id)).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect((yield* sessions.list()).filter((item) => item.parentID === root.id)).toHaveLength(0)

      permissionDenied = false
      const child = yield* sessions.createChild({ parentID: root.id, agent: AgentV2.ID.make("fixer") })
      maxDepth = 1
      const nested = yield* delegation.delegate(request(child.id)).pipe(Effect.exit)
      expect(Exit.isFailure(nested)).toBe(true)
      if (Exit.isFailure(nested)) expect(String(nested.cause)).toContain("depth limit")
    }),
  )

  it.instance("starts background work, admits a bounded completion envelope, and downgrades when denied", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const delegation = yield* DelegationService.Service
      const root = yield* parent()
      const notifications: { title?: string; metadata?: Record<string, unknown> }[] = []
      const result = yield* delegation.delegate(
        request(root.id, {
          background: true,
          metadata: (input) => Effect.sync(() => notifications.push(input)),
        }),
      )
      expect(result.background).toBe(true)
      expect(
        notifications.some((input) => input.metadata?.background === true && input.metadata.jobId === result.jobID),
      ).toBe(true)
      const jobs = yield* (yield* BackgroundJob.Service).wait({ id: result.sessionID })
      expect(jobs.info?.status).toBe("completed")

      const rows = yield* (yield* Database.Service).db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, root.id))
        .all()
        .pipe(Effect.orDie)
      expect(rows.some((row) => row.prompt.text.includes("<task_result>"))).toBe(true)

      backgroundPolicy = "deny"
      const foreground = yield* delegation.delegate(request(root.id, { background: true }))
      expect(foreground.background).toBe(false)
      expect(foreground.downgraded).toContain("policy")
      expect(sessions).toBeDefined()
    }),
  )

  it.instance("extends an active background child without starting a duplicate job", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      resumeEffect = Deferred.await(gate)
      const sessions = yield* SessionV2.Service
      const delegation = yield* DelegationService.Service
      const root = yield* parent()

      const first = yield* delegation.delegate(request(root.id, { background: true }))
      while (resumed.length === 0) yield* Effect.yieldNow
      const extended = yield* delegation.delegate(request(root.id, { background: true, task_id: first.sessionID }))

      expect(extended.background).toBe(true)
      expect(extended.jobID).toBe(first.jobID)
      expect(yield* sessions.get(extended.sessionID)).toMatchObject({ parentID: root.id })

      yield* Deferred.succeed(gate, undefined)
      const info = yield* (yield* BackgroundJob.Service).wait({ id: first.sessionID })
      expect(info.info?.status).toBe("completed")
      expect(resumed).toHaveLength(2)
    }),
  )

  it.live("interrupts the child and reports cancellation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      resumeEffect = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never as Effect.Effect<never, never, never>),
      )
      const delegation = yield* DelegationService.Service
      const root = yield* parent()
      const controller = new AbortController()
      const fiber = yield* delegation.delegate(request(root.id, { abort: controller.signal })).pipe(Effect.forkScoped)
      while (resumed.length === 0) yield* Effect.yieldNow
      controller.abort()
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(interrupted.length).toBeGreaterThan(0)
    }),
  )
})
