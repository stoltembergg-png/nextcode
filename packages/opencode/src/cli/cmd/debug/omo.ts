import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { agentDefinitions } from "@opencode-ai/core/omo"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { make } from "@opencode-ai/core/background-job"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode, makeLocationNode, Node } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer, LayerMap, Ref } from "effect"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { EOL, tmpdir } from "node:os"
import path from "node:path"
import { CliError, effectCmd } from "../../effect-cmd"
import { generateStrategies } from "../../../omo/strategy"
import { routeDeterministic } from "../../../omo/deterministic"
import { Agent } from "../../../agent/agent"
import { Config } from "../../../config/config"
import { EventV2Bridge } from "../../../event-v2-bridge"
import { RuntimeFlags } from "../../../effect/runtime-flags"
import { InstanceRef } from "../../../effect/instance-ref"
import type { InstanceContext } from "../../../project/instance-context"
import { Session } from "../../../session/session"
import { SessionRunState } from "../../../session/run-state"
import { SessionStatus } from "../../../session/status"
import { DelegationService } from "../../../omo/delegation"
import { BackgroundJob } from "../../../background/job"
import { OmoObservability } from "../../../omo/observability"
import { OmoRouter } from "../../../omo/router"
import { OmoStatus } from "../../../omo/status"
import { SemifService, type Status as SemifInfo } from "../../../semif/service"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionEvent } from "@opencode-ai/core/session/event"

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

const smokeEnvironmentKeys = [
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

const smokeGlobalPathKeys = ["data", "cache", "config", "state", "tmp", "bin", "log", "repos"] as const

const smokeConfigContent = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  omo: {
    enabled: true,
    preset: "auto",
    background: "allow",
    routing: "deterministic",
    verification: "tests",
    disabled_agents: [],
  },
  subagent_depth: 1,
})

type SmokeEnvironment = {
  readonly root: string
  readonly previous: Readonly<Record<(typeof smokeEnvironmentKeys)[number], string | undefined>>
  readonly previousPaths: Readonly<Record<(typeof smokeGlobalPathKeys)[number], string>>
}

function acquireSmokeEnvironment() {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const root = mkdtempSync(path.join(tmpdir(), "opencode-omo-smoke-"))
      const config = path.join(root, "config")
      const data = path.join(root, "data")
      const cache = path.join(root, "cache")
      const state = path.join(root, "state")
      const home = path.join(root, "home")
      const appData = path.join(root, "appdata")
      const localAppData = path.join(root, "localappdata")
      const tmp = path.join(root, "tmp")
      const bin = path.join(root, "bin")
      const log = path.join(root, "log")
      const repos = path.join(root, "repos")
      for (const directory of [config, data, cache, state, home, appData, localAppData, tmp, bin, log, repos]) {
        mkdirSync(directory, { recursive: true })
      }
      writeFileSync(path.join(config, "opencode.json"), smokeConfigContent)

      const previous = Object.fromEntries(
        smokeEnvironmentKeys.map((key) => [key, process.env[key]]),
      ) as SmokeEnvironment["previous"]
      const previousPaths = Object.fromEntries(
        smokeGlobalPathKeys.map((key) => [key, Global.Path[key]]),
      ) as SmokeEnvironment["previousPaths"]
      const values: Readonly<Partial<Record<(typeof smokeEnvironmentKeys)[number], string>>> = {
        APPDATA: appData,
        HOME: home,
        LOCALAPPDATA: localAppData,
        USERPROFILE: home,
        OPENCODE_CONFIG: undefined,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_CONFIG_CONTENT: smokeConfigContent,
        OPENCODE_DB: ":memory:",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_PURE: "1",
        OPENCODE_TEST_HOME: home,
        SEMIF_MODE: "off",
        XDG_CACHE_HOME: cache,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_STATE_HOME: state,
      }
      for (const key of smokeEnvironmentKeys) {
        const value = values[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      const isolatedPaths = { data, cache, config, state, tmp, bin, log, repos }
      for (const key of smokeGlobalPathKeys) Global.Path[key] = isolatedPaths[key]
      return { root, previous, previousPaths }
    }),
    (environment: SmokeEnvironment) =>
      Effect.sync(() => {
        for (const key of smokeGlobalPathKeys) Global.Path[key] = environment.previousPaths[key]
        for (const key of smokeEnvironmentKeys) {
          const value = environment.previous[key]
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(environment.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 })
      }),
  )
}

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
  return Effect.scoped(
    Effect.gen(function* () {
      yield* acquireSmokeEnvironment()
      const scopeClosed = yield* Ref.make(false)
      const disposalEvidence = {
        background: yield* Ref.make(false),
        execution: yield* Ref.make(false),
        runner: yield* Ref.make(false),
      }
      const executionRef = yield* Ref.make<SessionExecution.Interface | undefined>(undefined)
      const backgroundRef = yield* Ref.make<BackgroundJob.Interface | undefined>(undefined)
      const report = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Ref.set(scopeClosed, true))
          const config = yield* Config.Service
          const status = yield* OmoStatus.Service
          const router = yield* OmoRouter.Service
          const delegation = yield* DelegationService.Service
          const sessions = yield* SessionV2.Service
          const background = yield* BackgroundJob.Service
          const execution = yield* SessionExecution.Service
          yield* Ref.set(executionRef, execution)
          yield* Ref.set(backgroundRef, background)
          const metadataEvents: unknown[] = []
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
            metadata: (input) => Effect.sync(() => metadataEvents.push(input)),
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
          const backgroundResult = yield* delegation.delegate({
            kind: "v2",
            description: "OMO packaged smoke background",
            prompt: "Run the deterministic background check.",
            sessionID: parent.id,
            agent: backgroundRecommendation.agent,
            background: true,
            model: parent.model,
            variant: parent.model?.variant,
            abort: new AbortController().signal,
            metadata: (input) => Effect.sync(() => metadataEvents.push(input)),
          })
          if (!backgroundResult.background || !backgroundResult.jobID) throw new Error(errors.delegation)
          const backgroundJob = yield* background.wait({ id: backgroundResult.jobID })
          const activeJobs = yield* background.list()
          const statusInfo = yield* status.status()
          const backgroundChild = yield* sessions.get(backgroundResult.sessionID)
          if (metadataEvents.length < 2) throw new Error(errors.delegation)
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
              agent: backgroundChild.agent,
              started: backgroundResult.state === "running",
              active_jobs: activeJobs.filter((job) => job.status === "running").length,
            },
            servicesDisposed: false,
          })
        }).pipe(Effect.provide(makeSmokeLayer(disposalEvidence))),
      )
      const servicesClosed = yield* Ref.get(scopeClosed)
      const execution = yield* Ref.get(executionRef)
      const background = yield* Ref.get(backgroundRef)
      const backgroundFinalized = yield* Ref.get(disposalEvidence.background)
      const executionFinalized = yield* Ref.get(disposalEvidence.execution)
      const runnerFinalized = yield* Ref.get(disposalEvidence.runner)
      const activeSessions = execution ? yield* execution.active : new Set<SessionV2.ID>()
      const remainingJobs = background ? yield* background.list() : []
      const servicesDisposed =
        servicesClosed &&
        backgroundFinalized &&
        executionFinalized &&
        runnerFinalized &&
        execution !== undefined &&
        background !== undefined &&
        activeSessions.size === 0 &&
        remainingJobs.every((job) => job.status !== "running")
      if (!servicesDisposed) throw new Error(errors.jobs)
      return {
        ...report,
        checks: {
          ...report.checks,
          disposal: { ...report.checks.disposal, services_disposed: servicesDisposed },
        },
      }
    }),
  )
}

export const OmoSmokeCommand = effectCmd({
  command: "omo-smoke",
  describe: "run a deterministic native OMO packaged-binary smoke test",
  instance: false,
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.debug.omoSmoke")(function* (args: { json?: boolean }) {
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
    const report = yield* runOmoSmokeServices().pipe(
      Effect.provideService(InstanceRef, instance),
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
const smokeConfig = {
  omo: {
    enabled: true,
    preset: "auto" as const,
    background: "allow" as const,
    routing: "deterministic" as const,
    verification: "tests" as const,
    disabled_agents: [],
  },
  plugin: [],
  subagent_depth: 1,
}
const controlledConfig = Config.Service.of({
  get: () => Effect.succeed(smokeConfig),
  getGlobal: () => Effect.succeed(smokeConfig),
  getGlobalReadOnly: () => Effect.succeed(smokeConfig),
  getConsoleState: () =>
    Effect.succeed({
      consoleManagedProviders: [],
      activeOrgName: undefined,
      switchableOrgCount: 0,
    }),
  update: () => Effect.void,
  updateGlobal: () => Effect.succeed({ info: smokeConfig, changed: false }),
  invalidate: () => Effect.void,
  directories: () => Effect.succeed([]),
  waitForDependencies: () => Effect.void,
})
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
type SmokeDisposalEvidence = {
  readonly background: Ref.Ref<boolean>
  readonly execution: Ref.Ref<boolean>
  readonly runner: Ref.Ref<boolean>
}

function makeSmokeLayer(evidence: SmokeDisposalEvidence) {
  const isolatedGlobalNode = makeGlobalNode({
    service: Global.Service,
    layer: Layer.effect(
      Global.Service,
      Effect.sync(() => {
        const home = process.env.OPENCODE_TEST_HOME ?? path.dirname(process.cwd())
        const data = process.env.XDG_DATA_HOME ?? path.join(home, "data")
        const cache = process.env.XDG_CACHE_HOME ?? path.join(home, "cache")
        const config = process.env.OPENCODE_CONFIG_DIR ?? path.join(home, "config")
        const state = process.env.XDG_STATE_HOME ?? path.join(home, "state")
        return Global.Service.of(
          Global.make({
            home,
            data,
            cache,
            config,
            state,
            tmp: path.join(cache, "tmp"),
            bin: path.join(cache, "bin"),
            log: path.join(data, "log"),
            repos: path.join(data, "repos"),
          }),
        )
      }),
    ),
    deps: [],
  })
  const controlledConfigNode = LayerNode.make({
    service: Config.Service,
    layer: Layer.succeed(Config.Service, controlledConfig),
    deps: [],
  })
  const controlledRunnerNode = makeLocationNode({
    service: SessionRunner.Service,
    layer: Layer.effect(
      SessionRunner.Service,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* Effect.addFinalizer(() => Ref.set(evidence.runner, true))
        return SessionRunner.Service.of({
          run: Effect.fn("OmoSmoke.SessionRunner.run")(function* (input) {
            const session = yield* store.get(input.sessionID)
            if (!session) return
            const model =
              session.model ??
              ModelV2.Ref.make({ providerID: ProviderV2.ID.make("controlled"), id: ModelV2.ID.make("smoke") })
            const agent = session.agent ?? "build"
            const assistantMessageID = SessionMessage.ID.create()
            const textID = `text_${assistantMessageID}`
            yield* events.publish(SessionEvent.Step.Started, {
              timestamp: yield* DateTime.now,
              sessionID: session.id,
              assistantMessageID,
              agent,
              model,
            })
            yield* events.publish(SessionEvent.Text.Started, {
              timestamp: yield* DateTime.now,
              sessionID: session.id,
              assistantMessageID,
              textID,
            })
            yield* events.publish(SessionEvent.Text.Ended, {
              timestamp: yield* DateTime.now,
              sessionID: session.id,
              assistantMessageID,
              textID,
              text: "Controlled OMO smoke completed.",
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              timestamp: yield* DateTime.now,
              sessionID: session.id,
              assistantMessageID,
              finish: "stop",
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            })
          }),
        })
      }),
    ),
    deps: [EventV2.node, SessionStore.node],
  })
  const smokeLocationServices = LayerNode.group([Location.node, AgentV2.node, PermissionV2.node, controlledRunnerNode])
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
  const backgroundLayer = Layer.effect(
    BackgroundJob.Service,
    Effect.gen(function* () {
      const service = yield* make
      yield* Effect.addFinalizer(() => Ref.set(evidence.background, true))
      return service
    }),
  )
  const backgroundNode = LayerNode.make({ service: BackgroundJob.Service, layer: backgroundLayer, deps: [] })
  const executionLayer = SessionExecutionLocal.layer.pipe(
    Layer.tap(() => Effect.addFinalizer(() => Ref.set(evidence.execution, true))),
  )
  const executionNode = makeGlobalNode({
    service: SessionExecution.Service,
    layer: executionLayer,
    deps: [SessionStore.node, LocationServiceMap.node],
  })
  const nativeDelegationNode = LayerNode.make({
    service: DelegationService.Service,
    layer: DelegationService.layerForTests.pipe(Layer.fresh, Layer.provide(backgroundLayer)),
    deps: [Agent.node, Config.node, Database.node, RuntimeFlags.node, Session.node],
  })

  return AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Config.node,
      Database.node,
      nativeDelegationNode,
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
      [BackgroundJob.node, backgroundNode],
      [Config.node, controlledConfigNode],
      [Database.node, Database.layerFromPath(":memory:")],
      [DelegationService.node, nativeDelegationNode],
      [Global.node, isolatedGlobalNode],
      [LocationServiceMap.node, smokeLocationMap],
      [SessionExecution.node, executionNode],
      [SemifService.node, controlledSemif],
    ],
  )
}
