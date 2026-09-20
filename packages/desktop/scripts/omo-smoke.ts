import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const AGENTS = ["orchestrator", "explore", "librarian", "oracle", "designer", "fixer", "observer"] as const
const DEFAULT_DEADLINE_MS = 60_000
const RETRY_MS = 250
const REQUEST_TIMEOUT_MS = 2_000

const [binaryPath, logPath] = Bun.argv.slice(2)
if (!binaryPath || !logPath) {
  throw new Error("usage: bun run smoke:omo -- <packaged-sidecar> <shell-log>")
}

const deadlineMs = readPositiveInteger(process.env.NEXTCODE_SMOKE_DEADLINE_MS, DEFAULT_DEADLINE_MS)
const startedAt = Date.now()
const sidecar = await runSidecar(binaryPath, deadlineMs)
const endpoint = await pollReadyEndpoint(logPath, deadlineMs)
const headers = authorizationHeaders()
const status = await pollServer(endpoint, headers, deadlineMs)
await disposeInstance(endpoint, headers, deadlineMs)
await stopShell(deadlineMs)

console.log(
  JSON.stringify({
    schema: "nextcode.desktop-omo-smoke/v1",
    result: "passed",
    endpoint,
    sidecar,
    status: {
      enabled: status.enabled,
      preset: status.preset,
      agents: status.agents,
      semif: { status: status.semif.status, mode: status.semif.mode, download: status.semif.download },
      conflict: status.conflict,
    },
    elapsed_ms: Date.now() - startedAt,
  }),
)

async function runSidecar(path: string, deadline: number) {
  const smokeDirectory = await mkdtemp(join(tmpdir(), "nextcode-omo-smoke-"))
  const smokeConfig = JSON.stringify({
    omo: {
      enabled: true,
      preset: "auto",
      background: "allow",
      routing: "deterministic",
      verification: "tests",
      disabled_agents: [],
    },
    semif: { mode: "off", download: "never" },
  })
  await Promise.all([
    writeFile(join(smokeDirectory, "opencode.json"), smokeConfig),
    mkdir(join(smokeDirectory, "opencode"), { recursive: true }).then(() =>
      writeFile(join(smokeDirectory, "opencode", "opencode.json"), smokeConfig),
    ),
  ])
  const env = {
    ...process.env,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DB: ":memory:",
    OPENCODE_CONFIG_DIR: smokeDirectory,
    XDG_CONFIG_HOME: smokeDirectory,
    XDG_CACHE_HOME: smokeDirectory,
    XDG_DATA_HOME: smokeDirectory,
    XDG_STATE_HOME: smokeDirectory,
    OPENCODE_PURE: "1",
    SEMIF_MODE: "off",
  }
  try {
    const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(path, ["--pure", "debug", "omo-smoke", "--json"], {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      let stdout = ""
      let stderr = ""
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill("SIGTERM")
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref()
        reject(new Error(`OMO sidecar smoke timed out after ${deadline}ms`))
      }, deadline)
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })
      child.once("error", (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      })
      child.once("close", (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve({ stdout, stderr, code })
      })
    })
    if (output.code !== 0)
      throw new Error(`OMO sidecar smoke failed with code ${String(output.code)}: ${tail(output.stderr)}`)
    const report = parseLastJson(output.stdout)
    validateSmokeReport(report)
    return {
      code: output.code,
      execution: report.execution,
      child_identities: [report.checks.foreground.child_id, report.checks.background.child_id],
    }
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true })
  }
}

async function pollReadyEndpoint(logPath: string, deadline: number) {
  const until = Date.now() + deadline
  while (Date.now() < until) {
    const log = await readFile(logPath, "utf8").catch(() => "")
    const match = log.match(/server ready at (https?:\/\/[^\s]+)/)
    if (match?.[1]) return match[1].replace(/[),]+$/, "")
    if (log.includes("server did not become healthy") || log.includes("sidecar failed")) {
      throw new Error("desktop shell failed before reporting server readiness")
    }
    await retryDelay(until)
  }
  throw new Error(`desktop shell did not report server readiness within ${deadline}ms`)
}

async function pollServer(endpoint: string, headers: HeadersInit, deadline: number) {
  const until = Date.now() + deadline
  let lastError = "unknown server error"
  while (Date.now() < until) {
    try {
      const health = await fetchHealth(endpoint, headers)
      if (!health.ok) {
        lastError = `health returned ${health.status}`
        await retryDelay(until)
        continue
      }
      const healthBody: unknown = await health.json()
      if (!isHealth(healthBody)) {
        lastError = "health response did not confirm readiness"
        await retryDelay(until)
        continue
      }
      const response = await fetch(new URL("/omo/status", endpoint), {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.status === 401) throw new Error("/omo/status requires NEXTCODE_SMOKE_USERNAME/PASSWORD")
      if (!response.ok) {
        lastError = `/omo/status returned ${response.status}`
        await retryDelay(until)
        continue
      }
      const status = unwrapData(await response.json())
      validateStatus(status)
      return status
    } catch (error) {
      if (error instanceof Error && error.message.includes("requires NEXTCODE_SMOKE")) throw error
      lastError = error instanceof Error ? error.message : String(error)
      await retryDelay(until)
    }
  }
  throw new Error(`desktop server did not become OMO-ready within ${deadline}ms: ${lastError}`)
}

async function fetchHealth(endpoint: string, headers: HeadersInit) {
  const response = await fetch(new URL("/api/health", endpoint), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status !== 404) {
    if (response.status === 401) throw new Error("/api/health requires NEXTCODE_SMOKE_USERNAME/PASSWORD")
    return response
  }
  const legacy = await fetch(new URL("/global/health", endpoint), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (legacy.status === 401) throw new Error("/global/health requires NEXTCODE_SMOKE_USERNAME/PASSWORD")
  return legacy
}

async function disposeInstance(endpoint: string, headers: HeadersInit, deadline: number) {
  const response = await fetch(new URL("/instance/dispose", endpoint), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, deadline)),
  })
  if (response.status === 401) throw new Error("/instance/dispose requires NEXTCODE_SMOKE_USERNAME/PASSWORD")
  if (!response.ok) throw new Error(`/instance/dispose returned ${response.status}`)
  const body = unwrapData(await response.json())
  if (body !== true) throw new Error("/instance/dispose did not confirm disposal")
}

async function stopShell(deadline: number) {
  const pid = Number(process.env.NEXTCODE_SMOKE_SHELL_PID)
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error
  }
  const until = Date.now() + deadline
  while (Date.now() < until) {
    if (!processExists(pid)) return
    await retryDelay(until)
  }
  throw new Error(`desktop shell process ${pid} did not exit after graceful shutdown`)
}

function authorizationHeaders(): HeadersInit {
  const username = process.env.NEXTCODE_SMOKE_USERNAME
  const password = process.env.NEXTCODE_SMOKE_PASSWORD
  if (!username || !password) return {}
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}

function validateSmokeReport(value: unknown): asserts value is SmokeReport {
  if (!isRecord(value)) throw new Error("OMO sidecar smoke returned a non-object report")
  if (value.schema !== "nextcode.omo-smoke/v1" || value.result !== "passed" || value.mode !== "controlled") {
    throw new Error("OMO sidecar smoke returned an invalid report header")
  }
  if (value.execution !== "v2-services" || value.external_plugins !== false) {
    throw new Error("OMO sidecar smoke did not exercise the controlled native service graph")
  }
  if (
    !isRecord(value.semif) ||
    value.semif.mode !== "controlled" ||
    value.semif.network !== false ||
    value.semif.downloads !== false
  ) {
    throw new Error("OMO sidecar smoke did not prove SemIf stayed offline")
  }
  if (!isRecord(value.checks)) throw new Error("OMO sidecar smoke omitted checks")
  const checks = value.checks
  if (!isRecord(checks.agents) || checks.agents.ok !== true || !sameAgents(checks.agents.ids)) {
    throw new Error("OMO sidecar smoke native agent roster is incomplete")
  }
  if (
    !isRecord(checks.status) ||
    checks.status.ok !== true ||
    checks.status.enabled !== true ||
    checks.status.preset !== "auto" ||
    checks.status.routing !== "deterministic" ||
    checks.status.semif !== "controlled"
  ) {
    throw new Error("OMO sidecar smoke status check failed")
  }
  const foreground = checks.foreground
  const background = checks.background
  const disposal = checks.disposal
  if (!isRecord(foreground) || !isRecord(background) || !isRecord(disposal))
    throw new Error("OMO sidecar smoke checks are incomplete")
  if (
    foreground.ok !== true ||
    foreground.state !== "completed" ||
    foreground.background !== false ||
    foreground.agent !== "fixer" ||
    typeof foreground.parent_id !== "string" ||
    typeof foreground.child_id !== "string" ||
    foreground.parent_id === foreground.child_id
  )
    throw new Error("OMO sidecar smoke foreground identity/delegation check failed")
  if (
    background.ok !== true ||
    background.started !== true ||
    background.state !== "completed" ||
    background.background !== true ||
    background.agent !== "fixer" ||
    background.active_jobs !== 0 ||
    background.parent_id !== foreground.parent_id ||
    typeof background.child_id !== "string" ||
    background.child_id === foreground.child_id
  )
    throw new Error("OMO sidecar smoke background identity/job check failed")
  if (disposal.ok !== true || disposal.active_jobs !== 0 || disposal.services_disposed !== true) {
    throw new Error("OMO sidecar smoke disposal check failed")
  }
}

function validateStatus(value: unknown): asserts value is OmoStatus {
  if (!isRecord(value)) throw new Error("/omo/status returned a non-object")
  if (value.enabled !== true || value.preset !== "auto" || !sameAgents(value.agents)) {
    throw new Error("/omo/status did not report the native OMO roster")
  }
  if (
    !isRecord(value.semif) ||
    value.semif.status !== "disabled" ||
    value.semif.mode !== "off" ||
    value.semif.download !== "never"
  ) {
    throw new Error("/omo/status did not report offline SemIf")
  }
  if (!isRecord(value.conflict) || value.conflict.active !== false)
    throw new Error("/omo/status reports a legacy OMO conflict")
}

function isHealth(value: unknown): boolean {
  const body = unwrapData(value)
  return isRecord(body) && body.healthy === true
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value
}

function sameAgents(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length === AGENTS.length && value.every((item, index) => item === AGENTS[index])
}

function parseLastJson(output: string) {
  for (const line of output.trim().split(/\r?\n/).toReversed()) {
    try {
      return JSON.parse(line) as unknown
    } catch {}
  }
  throw new Error("packaged sidecar did not emit JSON smoke output")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function retryDelay(until: number) {
  const remaining = until - Date.now()
  return new Promise<void>((resolve) => setTimeout(resolve, Math.min(RETRY_MS, Math.max(0, remaining))))
}

function tail(value: string) {
  return value.trim().split(/\r?\n/).slice(-8).join(" | ")
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isNoSuchProcess(error)) return false
    throw error
  }
}

function isNoSuchProcess(error: unknown) {
  return isRecord(error) && (error.code === "ESRCH" || error.code === "ENOENT")
}

type SmokeReport = {
  schema: string
  result: string
  mode: string
  execution: string
  external_plugins: boolean
  semif: Record<string, unknown>
  checks: Record<string, unknown>
}

type OmoStatus = {
  enabled: boolean
  preset: string
  agents: readonly string[]
  semif: Record<string, unknown>
  conflict: Record<string, unknown>
}
