type SmokeReport = {
  schema: "nextcode.omo-smoke/v1"
  result: "passed"
  checks: {
    agents: { ok: true; ids: string[] }
    status: { ok: true; enabled: boolean; routing: string }
    foreground: { ok: true; state: "completed"; parent_id: string; child_id: string }
    background: { ok: true; started: true; state: "completed"; active_jobs: 0 }
    disposal: { ok: true; active_jobs: 0 }
  }
}

const sidecar = Bun.argv[2]
const shellLog = Bun.argv[3]
if (!sidecar || !shellLog) {
  console.error("usage: bun run smoke:omo -- <sidecar> <shell-log>")
  process.exit(2)
}

const report = await runSidecar(sidecar)
validateReport(report)

const baseURL = process.env.NEXTCODE_SMOKE_URL ?? "http://127.0.0.1:4096"
await poll(`${baseURL}/api/health`, (value) => value.ok)
const status = await pollJson(`${baseURL}/omo/status`, (value) => value && typeof value === "object")
if (status.enabled !== true) throw new Error("native OMO status is not enabled")

const log = await Bun.file(shellLog).text().catch(() => "")
if (log && !log.includes("server ready")) throw new Error("desktop shell did not report server ready")

await fetch(`${baseURL}/instance/dispose`, { method: "POST" }).catch(() => undefined)
process.stdout.write(JSON.stringify({ ok: true, report, status: { enabled: status.enabled, preset: status.preset } }) + "\n")

async function runSidecar(binary: string) {
  const child = Bun.spawn([binary, "debug", "omo-smoke", "--json"], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`omo-smoke exited ${exitCode}: ${stderr.trim()}`)
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((value) => value.startsWith("{"))
  if (!line) throw new Error("omo-smoke did not emit JSON")
  return JSON.parse(line) as SmokeReport
}

async function poll(url: string, predicate: (response: Response) => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastError = ""
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (predicate(response)) return
      lastError = `${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`)
}

async function pollJson(url: string, predicate: (value: Record<string, unknown>) => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastError = ""
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        const value = (await response.json()) as Record<string, unknown>
        if (predicate(value)) return value
        lastError = "response did not satisfy predicate"
      } else {
        lastError = `${response.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`)
}

function validateReport(value: unknown): asserts value is SmokeReport {
  if (!value || typeof value !== "object") throw new Error("invalid omo-smoke report")
  const report = value as Partial<SmokeReport>
  if (report.schema !== "nextcode.omo-smoke/v1" || report.result !== "passed")
    throw new Error("omo-smoke report failed schema validation")
  if (!report.checks?.agents.ok || !report.checks.status.ok || !report.checks.foreground.ok) {
    throw new Error("omo-smoke report has failed checks")
  }
  if (!report.checks.background.ok || report.checks.background.active_jobs !== 0) {
    throw new Error("omo-smoke report has active background jobs")
  }
}
