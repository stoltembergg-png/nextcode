#!/usr/bin/env bun

// Manual/nightly SemIf probe for the native OMO routing contract.
//
// The probe is intentionally opt-in. A developer can run the contract checks
// without a model, while CI supplies the two verified artifacts and sets
// OMO_REAL_MODEL_REQUIRED=1 before starting the real llama-server process.
// Pass --verify-only to validate the pinned artifacts without starting it.
// Output is a small allow-listed report: prompts, model paths, URLs and child
// process output never become part of the report.

import net from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { HOST_TARGETS, lockTargetKey, type SemifVariant } from "./fetch-semif-server"
import lockfile from "./semif-server.lock.json" with { type: "json" }
import { parseSemifOptions } from "../src/semif/config"
import { SemifManifest } from "../src/semif/manifest"
import { SemifScoring, type SemifDecision } from "../src/semif/scoring"
import { SemifRuntime } from "../src/semif/runtime"
import { generateStrategies, type OmoStrategy } from "../src/omo/strategy"

const SCHEMA_VERSION = 1 as const
const MODEL = SemifManifest.MODEL
const SERVER_TAG = lockfile.tag
const REQUIRED_AGENTS = ["explore", "librarian", "oracle", "designer", "fixer", "observer"] as const
const VERIFICATIONS = ["none", "tests", "oracle", "observer"] as const

export const REAL_MODEL_STRATEGIES: readonly OmoStrategy[] = generateStrategies({
  eligibleAgents: REQUIRED_AGENTS,
  background: { available: false, policy: "allow" },
  verification: VERIFICATIONS,
})

export const REAL_MODEL_TASKS = [
  { id: "explore", question: "Map the repository and identify the relevant implementation files." },
  { id: "librarian", question: "Research the dependency API and summarize the authoritative integration path." },
  { id: "oracle", question: "Review the architecture and identify the safest implementation tradeoff." },
  { id: "designer", question: "Implement the requested interface change and preserve the visual system." },
  { id: "fixer", question: "Fix the reported regression and add a focused verification test." },
  { id: "observer", question: "Inspect the supplied visual evidence and report the relevant discrepancy." },
] as const

export function realModelOptions(): readonly { readonly id: string; readonly description: string }[] {
  return REAL_MODEL_STRATEGIES.map((strategy) => ({ id: strategy.id, description: strategy.id }))
}

type LifecycleStage = "offline" | "starting" | "ready" | "deciding" | "disposing" | "disposed"
type ProbeStatus = "passed" | "skipped" | "failed"

export type RealModelTaskReport = {
  readonly task: string
  readonly chosen: string
  readonly eligible: boolean
  readonly option_count: number
  readonly score_count: number
  readonly missing_slots: number
  readonly total_seconds: number
}

export type RealModelReport = {
  readonly schema: typeof SCHEMA_VERSION
  readonly status: ProbeStatus
  readonly lifecycle: readonly LifecycleStage[]
  readonly runtime: {
    readonly model: string
    readonly server: string
  }
  readonly tasks: readonly RealModelTaskReport[]
  readonly error_code?: string
}

class ProbeFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "OmoRealModelProbeFailure"
  }
}

type UnknownRecord = Record<string, unknown>
type StagedFile = { readonly path: string; readonly bytes: number; readonly sha256: string }
type VerifiedArtifacts = { readonly libsPath?: string }

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, code: string): UnknownRecord {
  if (!isRecord(value)) throw new ProbeFailure(code)
  return value
}

function requireArray(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ProbeFailure(code)
  return value
}

function requireFiniteNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ProbeFailure(code)
  return value
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProbeFailure(code)
  return value
}

/**
 * Validate the boundary between SemIf and OMO without making confidence
 * claims. Scores only need to be finite and sortable; no platform-dependent
 * probability threshold is part of the contract.
 */
export function assertRealModelDecision(
  value: unknown,
  eligibleStrategies: readonly OmoStrategy[] = REAL_MODEL_STRATEGIES,
): asserts value is SemifDecision {
  const record = requireRecord(value, "decision_not_object")
  const optionIds = requireArray(record.option_ids, "option_slots_missing")
  if (optionIds.length < 2 || optionIds.length > 16) throw new ProbeFailure("option_count_out_of_range")

  const eligible = new Set(eligibleStrategies.map((strategy) => strategy.id))
  const ids = optionIds.map((id) => requireString(id, "option_slot_malformed"))
  if (new Set(ids).size !== ids.length) throw new ProbeFailure("option_slots_duplicate")
  if (ids.some((id) => !eligible.has(id))) throw new ProbeFailure("option_slot_ineligible")

  const chosen = requireString(record.chosen, "chosen_strategy_missing")
  if (!eligible.has(chosen) || !ids.includes(chosen)) throw new ProbeFailure("chosen_strategy_ineligible")

  const missing = requireArray(record.missing_slots, "missing_slots_missing")
  if (missing.length !== 0) throw new ProbeFailure("answer_slot_missing")

  const probabilities = requireArray(record.probabilities, "probabilities_missing")
  const logits = requireArray(record.option_logits, "scores_missing")
  const answerTokens = requireArray(record.answer_token_ids, "answer_tokens_missing")
  if (probabilities.length !== ids.length || logits.length !== ids.length || answerTokens.length !== ids.length) {
    throw new ProbeFailure("decision_shape_invalid")
  }
  const finiteProbabilities = probabilities.map((score) => requireFiniteNumber(score, "probability_not_finite"))
  logits.forEach((score) => requireFiniteNumber(score, "score_not_finite"))
  answerTokens.forEach((token) => {
    if (typeof token !== "number" || !Number.isInteger(token) || token < 0) {
      throw new ProbeFailure("answer_token_invalid")
    }
  })

  const totalSeconds = requireFiniteNumber(record.total_seconds, "duration_not_finite")
  if (totalSeconds < 0) throw new ProbeFailure("duration_negative")

  // The actual SemIf scorer chooses the first maximum. Re-checking that rule
  // catches a response whose scores and selected ID disagree without asserting
  // any absolute confidence threshold.
  const selectedIndex = ids.indexOf(chosen)
  const bestIndex = finiteProbabilities.reduce(
    (best, score, index) => (score > finiteProbabilities[best]! ? index : best),
    0,
  )
  if (selectedIndex !== bestIndex) throw new ProbeFailure("chosen_score_mismatch")
}

const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  "offline",
  "starting",
  "ready",
  "deciding",
  "disposing",
  "disposed",
]

function isLifecycleStage(value: unknown): value is LifecycleStage {
  return typeof value === "string" && LIFECYCLE_STAGES.includes(value as LifecycleStage)
}

function safeDuration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : 0
}

/**
 * Convert an arbitrary internal result into the only shape allowed in CI logs.
 * The function deliberately copies individual primitive fields instead of
 * serializing the input, so an accidental prompt/path field cannot escape.
 */
export function sanitizeProbeReport(value: unknown): RealModelReport {
  const record = isRecord(value) ? value : {}
  const rawLifecycle = Array.isArray(record.lifecycle) ? record.lifecycle : []
  const lifecycle = rawLifecycle.filter(isLifecycleStage)
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : []
  const tasks = rawTasks.flatMap((raw) => {
    if (!isRecord(raw)) return []
    const task =
      typeof raw.task === "string" && REAL_MODEL_TASKS.some((entry) => entry.id === raw.task) ? raw.task : undefined
    const chosen =
      typeof raw.chosen === "string" && REAL_MODEL_STRATEGIES.some((entry) => entry.id === raw.chosen)
        ? raw.chosen
        : undefined
    if (!task || !chosen) return []
    return [
      {
        task,
        chosen,
        eligible: raw.eligible === true,
        option_count: typeof raw.option_count === "number" && Number.isInteger(raw.option_count) ? raw.option_count : 0,
        score_count: typeof raw.score_count === "number" && Number.isInteger(raw.score_count) ? raw.score_count : 0,
        missing_slots:
          typeof raw.missing_slots === "number" && Number.isInteger(raw.missing_slots) ? raw.missing_slots : 0,
        total_seconds: safeDuration(raw.total_seconds),
      },
    ]
  })
  const status =
    record.status === "passed" || record.status === "skipped" || record.status === "failed" ? record.status : "failed"
  const errorCode =
    typeof record.error_code === "string" && /^[a-z0-9_]{1,64}$/.test(record.error_code) ? record.error_code : undefined
  return {
    schema: SCHEMA_VERSION,
    status,
    lifecycle,
    runtime: {
      model: `${MODEL.source}:${MODEL.quant}`,
      server: `llama.cpp ${SERVER_TAG}`,
    },
    tasks,
    ...(errorCode ? { error_code: errorCode } : {}),
  }
}

function envFlag(name: string): boolean {
  return process.env[name] === "1" || process.env[name]?.toLowerCase() === "true"
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new ProbeFailure("free_port_unavailable")))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function inspectFile(filePath: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) throw new ProbeFailure("artifact_missing")
  const hash = new Bun.CryptoHasher("sha256")
  let bytes = 0
  const reader = file.stream().getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    hash.update(next.value)
  }
  return { bytes, sha256: hash.digest("hex") }
}

function targetForHost(): string {
  const target = HOST_TARGETS[`${process.platform}-${process.arch}`]
  if (!target) throw new ProbeFailure("runner_unsupported")
  return target
}

function defaultMarkerPath(target: string, variant: string): string {
  return path.resolve(
    import.meta.dir,
    "../../desktop/src-tauri/.semif-cache",
    `${lockTargetKey(target, variant as SemifVariant)}.json`,
  )
}

async function verifyPinnedArtifacts(modelPath: string, serverPath: string): Promise<VerifiedArtifacts> {
  const model = await inspectFile(modelPath)
  if (model.bytes !== MODEL.bytes || model.sha256 !== MODEL.sha256) throw new ProbeFailure("model_unverified")

  const target = targetForHost()
  const variant = process.env.SEMIF_VARIANT?.trim() || "cpu"
  if (variant !== "cpu" && variant !== "hip" && variant !== "cuda" && variant !== "vulkan") {
    throw new ProbeFailure("runtime_variant_invalid")
  }
  const lockTarget = lockTargetKey(target, variant as SemifVariant)
  const expected = lockfile.targets[lockTarget as keyof typeof lockfile.targets]
  if (!expected) throw new ProbeFailure("runtime_unpinned")

  const markerPath = process.env.SEMIF_SERVER_MARKER?.trim() || defaultMarkerPath(target, variant)
  const markerFile = Bun.file(markerPath)
  if (!(await markerFile.exists())) throw new ProbeFailure("runtime_marker_missing")
  const marker = await markerFile.json().catch(() => undefined)
  const markerRecord = requireRecord(marker, "runtime_marker_invalid")
  if (
    markerRecord.tag !== lockfile.tag ||
    markerRecord.target !== lockTarget ||
    markerRecord.asset !== expected.asset ||
    markerRecord.sha256 !== expected.sha256
  ) {
    throw new ProbeFailure("runtime_marker_unverified")
  }
  const rawStaged = requireArray(markerRecord.staged, "runtime_staged_missing")
  const staged = rawStaged.map((entry) => {
    const record = requireRecord(entry, "runtime_staged_invalid")
    const stagedPath = requireString(record.path, "runtime_staged_path_missing")
    const bytes = record.bytes
    const sha256 = record.sha256
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
      throw new ProbeFailure("runtime_staged_size_invalid")
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new ProbeFailure("runtime_staged_hash_invalid")
    }
    return { path: stagedPath, bytes, sha256: sha256.toLowerCase() } satisfies StagedFile
  })
  if (staged.length === 0) throw new ProbeFailure("runtime_staged_missing")

  const serverName = path.basename(serverPath)
  const serverEntry = staged.find((entry) => path.basename(entry.path) === serverName)
  if (!serverEntry) throw new ProbeFailure("runtime_binary_unverified")
  const actualServer = await inspectFile(serverPath)
  if (actualServer.bytes !== serverEntry.bytes || actualServer.sha256 !== serverEntry.sha256) {
    throw new ProbeFailure("runtime_binary_unverified")
  }

  for (const entry of staged) {
    const actual = await inspectFile(entry.path)
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new ProbeFailure("runtime_staged_unverified")
    }
  }

  const archive = await inspectFile(path.join(path.dirname(markerPath), expected.asset))
  if (archive.bytes !== expected.bytes || archive.sha256 !== expected.sha256) {
    throw new ProbeFailure("runtime_archive_unverified")
  }

  const libraryPaths = staged
    .filter((entry) => path.basename(entry.path) !== serverName)
    .map((entry) => path.dirname(entry.path))
  if (libraryPaths.length === 0) throw new ProbeFailure("runtime_libs_missing")
  if (libraryPaths.some((directory) => directory !== libraryPaths[0])) {
    throw new ProbeFailure("runtime_lib_layout_invalid")
  }
  return { libsPath: libraryPaths[0] }
}

async function waitForReady(baseUrl: string, child: Bun.Subprocess, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new ProbeFailure("sidecar_exited_before_ready")
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
      if (response.status === 200) return
    } catch {
      // The process is still warming up or the short health request expired.
    }
    await Bun.sleep(250)
  }
  throw new ProbeFailure("sidecar_ready_timeout")
}

async function dispose(child: Bun.Subprocess): Promise<boolean> {
  try {
    child.kill()
    await Promise.race([child.exited, Bun.sleep(5000)])
    if (child.exitCode === null) {
      child.kill()
      await Promise.race([child.exited, Bun.sleep(5000)])
    }
    return child.exitCode !== null
  } catch {
    return false
  }
}

async function runProbe(): Promise<RealModelReport> {
  const modelPath = process.env.SEMIF_MODEL_PATH?.trim()
  const serverPath = process.env.SEMIF_SERVER_PATH?.trim()
  if (!modelPath || !serverPath) {
    if (envFlag("OMO_REAL_MODEL_REQUIRED")) throw new ProbeFailure("artifact_paths_missing")
    return sanitizeProbeReport({ status: "skipped", lifecycle: ["offline"], tasks: [] })
  }

  const lifecycle: LifecycleStage[] = ["offline"]
  const taskReports: RealModelTaskReport[] = []
  let status: ProbeStatus = "failed"
  let errorCode: string | undefined
  let child: Bun.Subprocess | undefined
  let runtimeRoot: string | undefined

  try {
    const verified = await verifyPinnedArtifacts(modelPath, serverPath)
    runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "omo-semif-runtime-"))
    const runtime = await Effect.runPromise(
      Effect.provide(
        SemifRuntime.materialize({ serverPath, libsPath: verified.libsPath, root: runtimeRoot }),
        NodeFileSystem.layer,
      ),
    )
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const timeoutMs = envInteger("OMO_REAL_MODEL_TIMEOUT_MS", 300_000, 30_000, 900_000)
    const config = parseSemifOptions({
      mode: "auto",
      host: "127.0.0.1",
      port,
      threads: envInteger("SEMIF_THREADS", 4, 1, 32),
      contextSize: envInteger("SEMIF_CONTEXT_SIZE", 2048, 256, 32_768),
      nProbs: 256,
      cacheSize: 0,
      loadTimeoutMs: timeoutMs,
    })

    lifecycle.push("starting")
    const runtimePath = runtime.dir
    const withRuntimePath = (name: string): string =>
      [runtimePath, process.env[name]].filter((value): value is string => Boolean(value)).join(path.delimiter)
    child = Bun.spawn({
      cmd: [
        runtime.serverPath,
        "-m",
        modelPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--threads",
        String(config.threads),
        "-c",
        String(config.contextSize),
        "--no-webui",
        "--parallel",
        "2",
      ],
      cwd: runtimePath,
      env: {
        ...process.env,
        PATH: withRuntimePath("PATH"),
        LD_LIBRARY_PATH: withRuntimePath("LD_LIBRARY_PATH"),
        DYLD_LIBRARY_PATH: withRuntimePath("DYLD_LIBRARY_PATH"),
        DYLD_FALLBACK_LIBRARY_PATH: withRuntimePath("DYLD_FALLBACK_LIBRARY_PATH"),
        GGML_BACKEND_PATH: runtimePath,
        SEMIF_MODE: "off",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    await waitForReady(baseUrl, child, Date.now() + timeoutMs)
    lifecycle.push("ready")

    const signal = AbortSignal.timeout(timeoutMs)
    const http = { url: baseUrl, signal }
    await SemifScoring.prepare(http, SemifManifest.profile(MODEL).family)
    lifecycle.push("deciding")
    for (const task of REAL_MODEL_TASKS) {
      const record = await SemifScoring.decide(
        http,
        config,
        {
          id: `omo-real-model-${task.id}`,
          state: { task: task.id, evidence: "representative native OMO routing task" },
          question: task.question,
          options: [...realModelOptions()],
        },
        SemifManifest.profile(MODEL),
      )
      assertRealModelDecision(record)
      taskReports.push({
        task: task.id,
        chosen: record.chosen,
        eligible: true,
        option_count: record.option_ids.length,
        score_count: record.option_logits.length,
        missing_slots: record.missing_slots.length,
        total_seconds: safeDuration(record.total_seconds),
      })
    }
    status = "passed"
  } catch (error) {
    errorCode = error instanceof ProbeFailure ? error.code : "probe_failed"
  } finally {
    if (child !== undefined) {
      lifecycle.push("disposing")
      if (await dispose(child)) lifecycle.push("disposed")
      else errorCode ??= "disposal_failed"
    }
    if (runtimeRoot !== undefined) {
      try {
        await rm(runtimeRoot, { recursive: true, force: true })
      } catch {
        errorCode ??= "runtime_cleanup_failed"
      }
    }
  }

  if (errorCode !== undefined) status = "failed"
  if (status === "passed" && (taskReports.length !== REAL_MODEL_TASKS.length || lifecycle.at(-1) !== "disposed")) {
    status = "failed"
    errorCode = "lifecycle_incomplete"
  }

  return sanitizeProbeReport({ status, lifecycle, tasks: taskReports, error_code: errorCode })
}

async function writeReport(report: RealModelReport): Promise<void> {
  const output = process.env.OMO_REAL_MODEL_OUTPUT?.trim()
  if (output) await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
}

async function main(): Promise<void> {
  if (process.argv.includes("--verify-only")) {
    const modelPath = process.env.SEMIF_MODEL_PATH?.trim()
    const serverPath = process.env.SEMIF_SERVER_PATH?.trim()
    if (!modelPath || !serverPath) throw new ProbeFailure("artifact_paths_missing")
    await verifyPinnedArtifacts(modelPath, serverPath)
    await writeReport(sanitizeProbeReport({ status: "passed", lifecycle: ["offline"], tasks: [] }))
    return
  }
  const report = await runProbe()
  await writeReport(report)
  if (report.status === "failed") process.exitCode = 1
}

if (import.meta.main) {
  await main().catch(async (error: unknown) => {
    const report = sanitizeProbeReport({
      status: "failed",
      lifecycle: ["offline"],
      tasks: [],
      error_code: error instanceof ProbeFailure ? error.code : "probe_failed",
    })
    await writeReport(report)
    process.exitCode = 1
  })
}
