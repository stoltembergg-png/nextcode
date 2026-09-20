import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { agentDefinitions } from "@opencode-ai/core/omo"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { DateTime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerMap, Effect, Layer, Ref } from "effect"
import { EOL } from "os"
import { CliError, effectCmd } from "../../effect-cmd"
import { generateStrategies } from "../../../omo/strategy"
import { routeDeterministic } from "../../../omo/deterministic"
import { Agent } from "../../../agent/agent"
import { BackgroundJob } from "../../../background/job"
import { Config } from "../../../config/config"
import { EventV2Bridge } from "../../../event-v2-bridge"
import { RuntimeFlags } from "../../../effect/runtime-flags"
import { Session } from "../../../session/session"
import { SessionRunState } from "../../../session/run-state"
import { SessionStatus } from "../../../session/status"
import { DelegationService } from "../../../omo/delegation"
import { OmoObservability } from "../../../omo/observability"
import { OmoRouter } from "../../../omo/router"
import { OmoStatus } from "../../../omo/status"
import { SemifService, type Status as SemifInfo } from "../../../semif/service"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const PARENT_ID = "ses_omo_smoke_parent"
const FOREGROUND_CHILD_ID = "ses_omo_smoke_foreground"
const BACKGROUND_CHILD_ID = "ses_omo_smoke_background"

const errors = {
  agents: "OMO smoke: native agent roster is incomplete",
  status: "OMO smoke: native status is not deterministic",
  identity: "OMO smoke: parent/child identity is invalid",
  delegation: "OMO smoke: deterministic delegation failed",
  jobs: "OMO smoke: background job leaked",
} as const

type ForegroundCheck = {
  readonly ok: boolean
  readonly parent_id: string
  readonly child_id: string
  readonly agent: ConfigOmo.AgentID
  readonly state: "completed" | "error"
  readonly background: false
}

type BackgroundCheck = {
  readonly ok: boolean
  readonly parent_id: string
  readonly child_id: string
  readonly agent: ConfigOmo.AgentID
  readonly started: boolean
  readonly state: "completed" | "error"
  readonly background: true
  readonly active_jobs: number
}

type DisposalCheck = {
  readonly ok: boolean
  readonly active_jobs: number
  readonly services_disposed: boolean
}

export type OmoSmokeReport = Readonly<{
  readonly schema: "nextcode.omo-smoke/v1"
  readonly result: "passed"
  readonly mode: "controlled"
  readonly execution: "contract" | "v2-services"
  readonly external_plugins: false
  readonly semif: Readonly<{
    readonly mode: "controlled"
    readonly network: false
    readonly downloads: false
  }>
  readonly checks: Readonly<{
    readonly agents: Readonly<{ readonly ok: true; readonly ids: readonly ConfigOmo.AgentID[] }>
    readonly status: Readonly<{
      readonly ok: true
      readonly enabled: true
      readonly preset: ConfigOmo.Preset
      readonly routing: "deterministic"
      readonly semif: "controlled"
    }>
    readonly foreground: ForegroundCheck
    readonly background: BackgroundCheck
    readonly disposal: DisposalCheck
  }>
}>

export type OmoSmokeOverrides = Readonly<{
  readonly agents?: readonly string[]
  readonly foreground?: Readonly<Partial<ForegroundCheck>>
  readonly background?: Readonly<Partial<BackgroundCheck>>
  readonly disposal?: Readonly<Partial<DisposalCheck>>
}>

export const OmoSmoke = {
  errors,
}

export function runOmoSmoke(overrides: OmoSmokeOverrides = {}): OmoSmokeReport {
  const config = ConfigOmo.resolve({
    enabled: true,
    preset: "auto",
    background: "allow",
    routing: "deterministic",
    verification: "tests",
    disabled_agents: [],
  }).info
  const definitions = agentDefinitions(config)
  const ids = overrides.agents ?? definitions.map((agent) => agent.id)
  const strategyInput = {
    eligibleAgents: ConfigOmo.AgentIDs,
    background: { available: true, policy: config.background },
    verification: ["none", "tests", "oracle", "observer"],
  } as const
  const foregroundStrategies = generateStrategies({ ...strategyInput, explicit: { background: false } })
  const backgroundStrategies = generateStrategies({ ...strategyInput, explicit: { background: true } })
  const foregroundRoute = routeDeterministic({
    summary: "Implement the smoke test and run the tests now",
    strategies: foregroundStrategies,
    explicit: { agent: "fixer", background: false, verification: "tests" },
    fallbackReason: "controlled packaged smoke",
  })
  const backgroundRoute = routeDeterministic({
    summary: "Run the smoke test in the background and report completion",
    strategies: backgroundStrategies,
    explicit: { agent: "fixer", background: true, verification: "tests" },
    fallbackReason: "controlled packaged smoke",
  })

  const foreground = {
    ok: true,
    parent_id: PARENT_ID,
    child_id: FOREGROUND_CHILD_ID,
    agent: foregroundRoute.agent,
    state: "completed" as const,
    background: false as const,
    ...overrides.foreground,
  }
  const background = {
    ok: true,
    parent_id: PARENT_ID,
    child_id: BACKGROUND_CHILD_ID,
    agent: backgroundRoute.agent,
    started: true,
    state: "completed" as const,
    background: true as const,
    active_jobs: 0,
    ...overrides.background,
  }
  const disposal = {
    ok: true,
    active_jobs: 0,
    services_disposed: true,
    ...overrides.disposal,
  }

  if (!sameAgentIDs(ids)) throw new Error(errors.agents)
  if (
    !config.enabled ||
    config.preset !== "auto" ||
    config.routing !== "deterministic" ||
    config.background !== "allow" ||
    config.verification !== "tests"
  ) {
    throw new Error(errors.status)
  }
  if (
    foreground.parent_id !== PARENT_ID ||
    foreground.child_id === PARENT_ID ||
    background.parent_id !== PARENT_ID ||
    background.child_id === PARENT_ID ||
    background.child_id === foreground.child_id
  ) {
    throw new Error(errors.identity)
  }
  if (
    !foreground.ok ||
    foreground.state !== "completed" ||
    foreground.background ||
    foreground.agent !== "fixer" ||
    !background.ok ||
    !background.started ||
    background.state !== "completed" ||
    !background.background ||
    background.agent !== "fixer"
  ) {
    throw new Error(errors.delegation)
  }
  if (!disposal.ok || !disposal.services_disposed || disposal.active_jobs !== 0 || background.active_jobs !== 0) {
    throw new Error(errors.jobs)
  }

  return {
    schema: "nextcode.omo-smoke/v1",
    result: "passed",
    mode: "controlled",
    execution: "contract",
    external_plugins: false,
    semif: {
      mode: "controlled",
      network: false,
      downloads: false,
    },
    checks: {
      agents: { ok: true, ids: [...ids] as ConfigOmo.AgentID[] },
      status: {
        ok: true,
        enabled: true,
        preset: config.preset,
        routing: "deterministic",
        semif: "controlled",
      },
      foreground,
      background,
      disposal,
    },
  }
}

/**
 * Runs the packaged smoke against the real OMO router, V2 session and
 * delegation services while replacing only the model/sidecar boundary with a
 * deterministic in-process execution. No provider, model download, or user
 * database is reachable from this graph.
 */
export function runOmoSmokeServices() {
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
  process.env.OPENCODE_PURE = "1"
  process.env.SEMIF_MODE = "off"

  return Effect.gen(function* () {
    const disposed = yield* Ref.make(false)
    const report = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Ref.set(disposed, true))
        const config = yield* Config.Service
        const status = yield* OmoStatus.Service
        const router = yield* OmoRouter.Service
        const delegation = yield* DelegationService.Service
        const sessions = yield* SessionV2.Service
        const background = yield* BackgroundJob.Service
        const currentConfig = yield* config.getGlobalReadOnly()
        const resolvedConfig = ConfigOmo.resolve(currentConfig.omo).info
        const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd().replaceAll("\\", "/")) })
        const parent = yield* sessions.create({
          location,
          agent: AgentV2.ID.make("orchestrator"),
          model: ModelV2.Ref.make({
            providerID: ProviderV2.ID.make("controlled"),
            id: ModelV2.ID.make("smoke"),
          }),
        })
        const recommendation = yield* router.route({
          summary: "Implement the packaged smoke test and run the tests now",
          eligibleAgents: ConfigOmo.AgentIDs,
          backgroundAvailable: true,
          backgroundPolicy: resolvedConfig.background ?? "allow",
          verification: "tests",
          agent: "fixer",
          background: false,
          config: resolvedConfig,
        })
        const foreground = yield* delegation.delegate({
          kind: "v2",
          description: "OMO packaged smoke foreground",
          prompt: "Run the deterministic foreground check.",
          sessionID: parent.id,
          agent: recommendation.agent,
          background: false,
          model: parent.model,
          variant: parent.model?.variant,
          abort: new AbortController().signal,
        })
        const foregroundChild = yield* sessions.get(foreground.sessionID)
        const backgroundRecommendation = yield* router.route({
          summary: "Run the packaged smoke test in the background and report completion",
          eligibleAgents: ConfigOmo.AgentIDs,
          backgroundAvailable: true,
          backgroundPolicy: resolvedConfig.background ?? "allow",
          verification: "tests",
          agent: "fixer",
          background: true,
          config: resolvedConfig,
        })
        const backgroundChild = yield* sessions.createChild({
          parentID: parent.id,
          agent: AgentV2.ID.make(backgroundRecommendation.agent),
          model: parent.model,
        })
        yield* sessions.prompt({
          sessionID: backgroundChild.id,
          prompt: Prompt.make({ text: "Run the deterministic background check." }),
          resume: false,
        })
        const backgroundStarted = yield* background.start({
          id: backgroundChild.id,
          type: "omo_delegate",
          title: "OMO packaged smoke background",
          metadata: { parentSessionId: parent.id, sessionId: backgroundChild.id, background: true },
          run: Effect.gen(function* () {
            yield* sessions.resume(backgroundChild.id)
            return yield* readSmokeV2Result(sessions, backgroundChild.id)
          }),
        })
        const backgroundJob = yield* background.wait({ id: backgroundStarted.id })
        const activeJobs = yield* background.list()
        const statusInfo = yield* status.status()
        return buildServiceReport({
          status: statusInfo,
          agents: statusInfo.agents,
          parentID: parent.id,
          foreground: {
            sessionID: foreground.sessionID,
            state: foreground.state,
            background: foreground.background,
            agent: foregroundChild.agent,
          },
          background: {
            sessionID: backgroundChild.id,
            state: backgroundJob.info?.status === "completed" ? "completed" : "error",
            background: true,
            agent: (yield* sessions.get(backgroundChild.id)).agent,
            started: true,
            active_jobs: activeJobs.filter((job) => job.status === "running").length,
          },
          servicesDisposed: false,
        })
      }),
    )
    const servicesDisposed = yield* Ref.get(disposed)
    if (!servicesDisposed) throw new Error(errors.jobs)
    return {
      ...report,
      checks: {
        ...report.checks,
        disposal: { ...report.checks.disposal, services_disposed: servicesDisposed },
      },
    }
  }).pipe(Effect.provide(smokeLayer))
}

export const OmoSmokeCommand = effectCmd({
  command: "omo-smoke",
  describe: "run a deterministic native OMO packaged-binary smoke test",
  instance: true,
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.debug.omoSmoke")(function* (args: { json?: boolean }) {
    const report = yield* runOmoSmokeServices().pipe(
      Effect.mapError((error) => new CliError({ message: error instanceof Error ? error.message : String(error) })),
    )
    process.stdout.write(args.json ? JSON.stringify(report) + EOL : renderText(report) + EOL)
  }),
})

function sameAgentIDs(input: readonly string[]): input is readonly ConfigOmo.AgentID[] {
  return input.length === ConfigOmo.AgentIDs.length && input.every((id, index) => id === ConfigOmo.AgentIDs[index])
}

function requireAgentID(input: string | undefined): ConfigOmo.AgentID {
  if (ConfigOmo.AgentIDs.includes(input as ConfigOmo.AgentID)) return input as ConfigOmo.AgentID
  throw new Error(errors.agents)
}

function renderText(report: OmoSmokeReport) {
  return [
    "OMO packaged smoke: passed",
    `native agents: ${report.checks.agents.ids.join(", ")}`,
    `foreground child: ${report.checks.foreground.child_id}`,
    `background child: ${report.checks.background.child_id} (completed)`,
    "SemIf: controlled/offline",
  ].join(EOL)
}

function readSmokeV2Result(service: SessionV2.Interface, sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const messages = yield* service.messages({ sessionID, order: "desc", limit: 64 })
    const assistant = messages.find((message): message is SessionMessage.Assistant => message.type === "assistant")
    if (!assistant) return yield* Effect.fail(new Error(errors.delegation))
    const text = assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    if (!text) return yield* Effect.fail(new Error(errors.delegation))
    return text
  })
}

function buildServiceReport(input: {
  readonly status: OmoStatus.OmoStatusInfo
  readonly agents: readonly string[]
  readonly parentID: string
  readonly foreground: {
    readonly sessionID: string
    readonly state: "running" | "completed"
    readonly background: boolean
    readonly agent?: string
  }
  readonly background: {
    readonly sessionID: string
    readonly state: "completed" | "error"
    readonly background: boolean
    readonly agent?: string
    readonly started: boolean
    readonly active_jobs: number
  }
  readonly servicesDisposed: boolean
}): OmoSmokeReport {
  if (
    !input.status.enabled ||
    input.status.preset !== "auto" ||
    input.status.conflict.active ||
    input.status.semif.status !== "disabled" ||
    input.status.semif.mode !== "off" ||
    input.status.semif.download !== "never" ||
    !sameAgentIDs(input.agents)
  ) {
    throw new Error(errors.status)
  }

  const foreground = {
    ok: true,
    parent_id: input.parentID,
    child_id: input.foreground.sessionID,
    agent: requireAgentID(input.foreground.agent),
    state: input.foreground.state === "completed" ? ("completed" as const) : ("error" as const),
    background: false as const,
  }
  const background = {
    ok: true,
    parent_id: input.parentID,
    child_id: input.background.sessionID,
    agent: requireAgentID(input.background.agent),
    started: input.background.started,
    state: input.background.state,
    background: true as const,
    active_jobs: input.background.active_jobs,
  }
  const disposal = {
    ok: true,
    active_jobs: input.background.active_jobs,
    services_disposed: input.servicesDisposed,
  }
  if (
    foreground.state !== "completed" ||
    foreground.background ||
    foreground.child_id === foreground.parent_id ||
    background.state !== "completed" ||
    !background.started ||
    !background.background ||
    background.child_id === background.parent_id ||
    background.child_id === foreground.child_id
  ) {
    throw new Error(errors.delegation)
  }
  if (background.active_jobs !== 0) throw new Error(errors.jobs)

  return {
    schema: "nextcode.omo-smoke/v1",
    result: "passed",
    mode: "controlled",
    execution: "v2-services",
    external_plugins: false,
    semif: { mode: "controlled", network: false, downloads: false },
    checks: {
      agents: { ok: true, ids: [...input.agents] as ConfigOmo.AgentID[] },
      status: {
        ok: true,
        enabled: input.status.enabled,
        preset: input.status.preset,
        routing: "deterministic",
        semif: "controlled",
      },
      foreground,
      background,
      disposal,
    },
  }
}

const controlledSemifStatus: SemifInfo = {
  status: "disabled" as const,
  mode: "off" as const,
  download: "never" as const,
  backend: "cpu" as const,
  backendRequested: "cpu" as const,
  backendFallback: false,
  systemRuntimeMissing: false,
  choices: [],
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
}
const controlledSemif = Layer.succeed(
  SemifService.Service,
  SemifService.Service.of({
    status: () => Effect.succeed(controlledSemifStatus),
    statusReadOnly: () => Effect.succeed(controlledSemifStatus),
    start: () => Effect.succeed(controlledSemifStatus),
    acquire: () => Effect.succeed(controlledSemifStatus),
    decide: () => Effect.die(new Error("SemIf is disabled in the packaged smoke")),
    dispose: () => Effect.void,
  }),
)
const controlledBackground = Layer.effect(BackgroundJob.Service, CoreBackgroundJob.make)

const smokeLocationServices = LayerNode.group([Location.node, AgentV2.node, PermissionV2.node])
const nativeSmokeAgentLayer = Layer.effect(
  AgentV2.Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const resolved = ConfigOmo.resolve({ enabled: true, preset: "auto", disabled_agents: [] }).info
    yield* agents.transform((draft) => {
      for (const definition of agentDefinitions(resolved)) {
        draft.update(AgentV2.ID.make(definition.id), (item) => {
          item.description = definition.description
          item.system = definition.prompt
          item.mode = definition.mode
          item.permissions.push(
            ...definition.permissions.map((permission) => ({ ...permission })),
            ...(definition.permissionOverrides?.map((permission) => ({ ...permission })) ?? []),
          )
        })
      }
      draft.default(AgentV2.ID.make("orchestrator"))
    })
    return agents
  }).pipe(Effect.provide(AgentV2.locationLayer)),
)
const smokeLocationMap = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    (ref: Location.Ref) => {
      const location = LayerNode.hoist(smokeLocationServices, Node.tags.values.global, [
        [Location.node, Location.boundNode(ref)],
        [AgentV2.node, nativeSmokeAgentLayer],
      ])
      return LayerNode.compile(location.node).pipe(
        Layer.provide(LayerNode.compile(location.hoisted)),
      ) as unknown as Layer.Layer<LocationServices>
    },
    { idleTimeToLive: "1 minute" },
  ),
)

const deterministicExecution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const active = new Set<SessionV2.ID>()

    const run = (sessionID: SessionV2.ID) =>
      Effect.gen(function* () {
        if (active.has(sessionID)) return
        const session = yield* store.get(sessionID)
        if (!session) return
        const model =
          session.model ??
          ModelV2.Ref.make({ providerID: ProviderV2.ID.make("controlled"), id: ModelV2.ID.make("smoke") })
        const agent = session.agent ?? "build"
        const assistantMessageID = SessionMessage.ID.create()
        const textID = `text_${assistantMessageID}`
        active.add(sessionID)
        yield* Effect.gen(function* () {
          const timestamp = yield* DateTime.now
          yield* events.publish(SessionEvent.Step.Started, {
            timestamp,
            sessionID,
            assistantMessageID,
            agent,
            model,
          })
          yield* events.publish(SessionEvent.Text.Started, {
            timestamp: yield* DateTime.now,
            sessionID,
            assistantMessageID,
            textID,
          })
          yield* events.publish(SessionEvent.Text.Ended, {
            timestamp: yield* DateTime.now,
            sessionID,
            assistantMessageID,
            textID,
            text: "Controlled OMO smoke completed.",
          })
          yield* events.publish(SessionEvent.Step.Ended, {
            timestamp: yield* DateTime.now,
            sessionID,
            assistantMessageID,
            finish: "stop",
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        }).pipe(Effect.provide(locations.get(session.location)))
      }).pipe(Effect.ensuring(Effect.sync(() => active.delete(sessionID))))

    return SessionExecution.Service.of({
      active: Effect.sync(() => new Set(active)),
      resume: (sessionID) => run(sessionID),
      wake: (sessionID) => run(sessionID),
      interrupt: (sessionID) => Effect.sync(() => active.delete(sessionID)),
    })
  }),
)
const deterministicExecutionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: deterministicExecution,
  deps: [EventV2.node, SessionStore.node, LocationServiceMap.node],
})

const smokeLayer = AppNodeBuilder.build(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    Config.node,
    Database.node,
    DelegationService.node,
    EventV2.node,
    EventV2Bridge.node,
    LocationServiceMap.node,
    OmoObservability.node,
    OmoRouter.node,
    OmoStatus.node,
    PermissionSaved.node,
    ProjectV2.node,
    RuntimeFlags.node,
    Session.node,
    SessionExecution.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    SessionStore.node,
    SessionV2.node,
    SemifService.node,
  ]),
  [
    [BackgroundJob.node, controlledBackground],
    [Database.node, Database.layerFromPath(":memory:")],
    [LocationServiceMap.node, smokeLocationMap],
    [SessionExecution.node, deterministicExecutionNode],
    [SemifService.node, controlledSemif],
  ],
)
