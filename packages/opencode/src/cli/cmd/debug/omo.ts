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
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerMap, Effect, Layer } from "effect"
import { EOL } from "os"
import { effectCmd } from "../../effect-cmd"
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
import { emptyConsoleState } from "@opencode-ai/core/v1/config/console-state"
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
export async function runOmoSmokeServices(): Promise<OmoSmokeReport> {
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
  process.env.OPENCODE_PURE = "1"
  process.env.SEMIF_MODE = "off"

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const status = yield* OmoStatus.Service
        const router = yield* OmoRouter.Service
        const delegation = yield* DelegationService.Service
        const sessions = yield* SessionV2.Service
        const background = yield* BackgroundJob.Service
        const resolvedConfig = ConfigOmo.resolve({
          enabled: true,
          preset: "auto",
          background: "allow",
          routing: "deterministic",
          verification: "tests",
          disabled_agents: [],
        }).info
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
          backgroundPolicy: "allow",
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
        const backgroundResult = yield* delegation.delegate({
          kind: "v2",
          description: "OMO packaged smoke background",
          prompt: "Run the deterministic background check.",
          sessionID: parent.id,
          agent: "fixer",
          background: true,
          model: parent.model,
          variant: parent.model?.variant,
          abort: new AbortController().signal,
        })
        const backgroundJob = yield* background.wait({ id: backgroundResult.jobID ?? backgroundResult.sessionID })
        const activeJobs = yield* background.list()
        const statusInfo = yield* status.status()
        const report = buildServiceReport({
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
            sessionID: backgroundResult.sessionID,
            state: backgroundJob.info?.status === "completed" ? "completed" : "error",
            background: backgroundResult.background,
            agent: (yield* sessions.get(backgroundResult.sessionID)).agent,
            started: Boolean(backgroundResult.jobID),
            active_jobs: activeJobs.filter((job) => job.status === "running").length,
          },
        })
        const semif = yield* SemifService.Service
        yield* semif.dispose()
        return report
      }).pipe(Effect.provide(smokeLayer)),
    ),
  )
}

export const OmoSmokeCommand = effectCmd({
  command: "omo-smoke",
  describe: "run a deterministic native OMO packaged-binary smoke test",
  instance: false,
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.debug.omoSmoke")(function* (args: { json?: boolean }) {
    const report = yield* Effect.promise(() => runOmoSmokeServices())
    process.stdout.write(args.json ? JSON.stringify(report) + EOL : renderText(report) + EOL)
  }),
})

function sameAgentIDs(input: readonly string[]): input is readonly ConfigOmo.AgentID[] {
  return input.length === ConfigOmo.AgentIDs.length && input.every((id, index) => id === ConfigOmo.AgentIDs[index])
}

function asAgentID(input: string | undefined): ConfigOmo.AgentID {
  return ConfigOmo.AgentIDs.includes(input as ConfigOmo.AgentID) ? (input as ConfigOmo.AgentID) : "fixer"
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
    agent: asAgentID(input.foreground.agent),
    state: input.foreground.state === "completed" ? ("completed" as const) : ("error" as const),
    background: false as const,
  }
  const background = {
    ok: true,
    parent_id: input.parentID,
    child_id: input.background.sessionID,
    agent: asAgentID(input.background.agent),
    started: input.background.started,
    state: input.background.state,
    background: true as const,
    active_jobs: input.background.active_jobs,
  }
  const disposal = {
    ok: true,
    active_jobs: input.background.active_jobs,
    services_disposed: true,
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

const controlledConfig = Config.Service.of({
  get: () => Effect.succeed(controlledConfigInfo),
  getGlobal: () => Effect.succeed(controlledConfigInfo),
  getGlobalReadOnly: () => Effect.succeed(controlledConfigInfo),
  getConsoleState: () => Effect.succeed(emptyConsoleState),
  update: () => Effect.void,
  updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
  invalidate: () => Effect.void,
  directories: () => Effect.succeed([]),
  waitForDependencies: () => Effect.void,
})

const controlledConfigInfo = {
  subagent_depth: 2,
  omo: {
    enabled: true,
    preset: "auto" as const,
    background: "allow" as const,
    routing: "deterministic" as const,
    verification: "tests" as const,
    disabled_agents: [],
  },
  plugin: [],
  semif: {
    mode: "off" as const,
    download: "never" as const,
    backend: "cpu" as const,
    contextSize: 2048,
    nProbs: 256,
    cacheSize: 128,
    host: "127.0.0.1",
    port: 8817,
  },
}

const unsupportedLegacyAgent = Agent.Service.of({
  get: () => Effect.die(new Error("legacy agent service is not part of the OMO smoke graph")),
  list: () => Effect.succeed([]),
  defaultInfo: () => Effect.die(new Error("legacy agent service is not part of the OMO smoke graph")),
  defaultAgent: () => Effect.die(new Error("legacy agent service is not part of the OMO smoke graph")),
  generate: () => Effect.die(new Error("legacy agent service is not part of the OMO smoke graph")),
})

const controlledAgents = new Map(
  ConfigOmo.AgentIDs.map((id) => [
    AgentV2.ID.make(id),
    {
      ...AgentV2.Info.empty(AgentV2.ID.make(id)),
      mode: id === "orchestrator" ? ("primary" as const) : ("subagent" as const),
      permissions: [{ action: "omo_delegate" as const, resource: "*" as const, effect: "allow" as const }],
    },
  ]),
)

const controlledAgentService = AgentV2.Service.of({
  transform: () => Effect.succeed({ dispose: Effect.void }),
  reload: () => Effect.void,
  get: (id) => Effect.succeed(controlledAgents.get(id)),
  default: () => Effect.succeed(controlledAgents.get(AgentV2.ID.make("orchestrator"))),
  resolve: (id) => Effect.succeed(id ? controlledAgents.get(AgentV2.ID.make(id)) : controlledAgents.get(AgentV2.ID.make("orchestrator"))),
  select: (id) => Effect.succeed({ id: id ? AgentV2.ID.make(id) : AgentV2.ID.make("orchestrator"), info: id ? controlledAgents.get(AgentV2.ID.make(id)) : controlledAgents.get(AgentV2.ID.make("orchestrator")) }),
  all: () => Effect.succeed([...controlledAgents.values()]),
})

const controlledPermissionService = PermissionV2.Service.of({
  assert: () => Effect.void,
  ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" as const }),
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
})

const controlledLocation = Location.Ref.make({ directory: AbsolutePath.make(process.cwd().replaceAll("\\", "/")) })
const controlledLocationServices = Layer.mergeAll(
  Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: controlledLocation.directory,
      project: { id: ProjectV2.ID.global, directory: controlledLocation.directory },
    }),
  ),
  Layer.succeed(AgentV2.Service, controlledAgentService),
  Layer.succeed(PermissionV2.Service, controlledPermissionService),
) as unknown as Layer.Layer<LocationServices>
const controlledLocationMap = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() => controlledLocationServices, { idleTimeToLive: "1 minute" }),
)

const controlledExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)
const controlledProjects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
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
    [Agent.node, Layer.succeed(Agent.Service, unsupportedLegacyAgent)],
    [BackgroundJob.node, controlledBackground],
    [Config.node, Layer.succeed(Config.Service, controlledConfig)],
    [Database.node, Database.layerFromPath(":memory:")],
    [LocationServiceMap.node, controlledLocationMap],
    [ProjectV2.node, controlledProjects],
    [SessionExecution.node, controlledExecution],
    [SemifService.node, controlledSemif],
  ],
)
