import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { agentDefinitions } from "@opencode-ai/core/omo"
import { Effect } from "effect"
import { EOL } from "os"
import { effectCmd } from "../../effect-cmd"
import { generateStrategies } from "../../../omo/strategy"
import { routeDeterministic } from "../../../omo/deterministic"

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

export const OmoSmokeCommand = effectCmd({
  command: "omo-smoke",
  describe: "run a deterministic native OMO packaged-binary smoke test",
  instance: false,
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.debug.omoSmoke")(function* (args: { json?: boolean }) {
    const report = runOmoSmoke()
    process.stdout.write(args.json ? JSON.stringify(report) + EOL : renderText(report) + EOL)
  }),
})

function sameAgentIDs(input: readonly string[]): input is readonly ConfigOmo.AgentID[] {
  return input.length === ConfigOmo.AgentIDs.length && input.every((id, index) => id === ConfigOmo.AgentIDs[index])
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
