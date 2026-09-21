import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"

const LEGACY_FILE_NAMES = ["oh-my-opencode-slim.json", "oh-my-opencode-slim.jsonc"] as const
const NATIVE_PRESETS = ["auto", "openai", "opencode-go"] as const
const AGENT_IDS = new Set<string>(ConfigOmo.AgentIDs)
const AGENT_ALIASES = new Map([["explorer", "explore"]])

type NativePreset = (typeof NATIVE_PRESETS)[number]

export type MigrationFs = {
  readFile?: (file: string) => Promise<string>
  writeFile?: (file: string, data: string | Uint8Array) => Promise<void>
  mkdir?: (directory: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  rm?: (file: string) => Promise<void>
  exists?: (file: string) => Promise<boolean>
}

export type MigrationInput = {
  globalConfigDir?: string
  projectDir?: string
  cwd?: string
  targetFile?: string
  replace?: boolean
  now?: Date
  fs?: MigrationFs
}

export type UnsupportedField = {
  path: string
  message: string
}

export type MigrationSource = {
  path: string
  scope: "global" | "project"
  bytes: number
  hash: string
}

export type MigrationSourceError = {
  path: string
  scope: "global" | "project"
  code: "legacy_unreadable" | "invalid_legacy"
  message: string
}

export type PluginRemoval = {
  path: string
  index: number
  value: unknown
}

export type MigrationRefusal = {
  code: "native_omo_exists" | "invalid_target" | "invalid_legacy" | "legacy_unreadable" | "target_unreadable"
  message: string
}

export type MigrationPreview = {
  version: 1
  targetFile: string
  targetExists: boolean
  targetHash?: string
  targetDiff: {
    set: readonly string[]
    removePlugins: readonly string[]
  }
  sourceFiles: readonly MigrationSource[]
  sourceErrors: readonly MigrationSourceError[]
  native: ConfigOmo.Info
  normalized: ConfigOmo.Info
  imported: readonly string[]
  unsupported: readonly UnsupportedField[]
  unsupportedPaths: readonly string[]
  warnings: readonly string[]
  pluginKey?: "plugin" | "plugins"
  pluginRemovals: readonly PluginRemoval[]
  pluginPreserved: readonly unknown[]
  backupPath?: string
  replace: boolean
  refusal?: MigrationRefusal
  canApply: boolean
}

export type MigrationResult = Omit<MigrationPreview, "canApply"> & {
  status: "preview" | "applied" | "refused" | "failed"
  canApply: boolean
  reason?:
    | "stale_preview"
    | "native_omo_exists"
    | "invalid_target"
    | "invalid_legacy"
    | "legacy_unreadable"
    | "target_unreadable"
    | "write_failed"
    | "replace_requires_apply"
  error?: string
}

export async function discoverLegacyFiles(input: MigrationInput = {}) {
  const result = await discoverLegacyFilesWithFs(input, migrationFs(input.fs))
  return result.files
}

export async function planMigration(input: MigrationInput = {}): Promise<MigrationPreview> {
  const fs = migrationFs(input.fs)
  const discovered = await discoverLegacyFilesWithFs(input, fs)
  const sourceFiles: MigrationSource[] = []
  const legacy: Record<string, unknown>[] = []
  const unsupported: UnsupportedField[] = []
  const sourceErrors = [...discovered.errors]

  for (const source of discovered.files) {
    const read = await readOptional(fs, source.path)
    if (read.status === "missing") continue
    if (read.status === "error") {
      sourceErrors.push({
        path: source.path,
        scope: source.scope,
        code: "legacy_unreadable",
        message: errorMessage(read.error),
      })
      continue
    }
    const sourceText = read.text
    const parsed = parseLegacy(sourceText)
    sourceFiles.push({
      path: source.path,
      scope: source.scope,
      bytes: Buffer.byteLength(sourceText),
      hash: hash(sourceText),
    })
    if (parsed.errors.length > 0 || !isRecord(parsed.value)) {
      sourceErrors.push({
        path: source.path,
        scope: source.scope,
        code: "invalid_legacy",
        message: parsed.errors.length > 0 ? "invalid JSON/JSONC" : "top-level value must be an object",
      })
      unsupported.push({
        path: source.path,
        message: parsed.errors.length > 0 ? "invalid JSON/JSONC" : "top-level value must be an object",
      })
      continue
    }
    legacy.push(parsed.value)
  }

  const merged = mergeLegacy(legacy)
  const projection = projectLegacy(merged)
  unsupported.push(...projection.unsupported)

  const globalConfigDir = path.resolve(input.globalConfigDir ?? Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config)
  const targetSelection = input.targetFile
    ? { path: path.resolve(input.targetFile) }
    : await defaultTargetFile(globalConfigDir, fs)
  const targetFile = targetSelection.path
  const targetRead = targetSelection.error ? { status: "error" as const, error: targetSelection.error } : await readOptional(fs, targetFile)
  const targetText = targetRead.status === "ok" ? targetRead.text : undefined
  const targetParsed = targetRead.status === "ok" ? parseLegacy(targetRead.text) : { value: {}, errors: [] as ParseError[] }
  const targetData = isRecord(targetParsed.value) ? targetParsed.value : undefined
  const sourceRefusal = sourceErrors[0]
    ? ({
        code: sourceErrors[0].code,
        message: `${sourceErrors[0].path}: ${sourceErrors[0].message}`,
      } as const)
    : undefined
  const targetRefusal = targetRead.status === "error"
    ? ({ code: "target_unreadable", message: `${targetFile}: ${errorMessage(targetRead.error)}` } as const)
    : targetParsed.errors.length
    ? ({ code: "invalid_target", message: `${targetFile} contains invalid JSON/JSONC` } as const)
    : targetText !== undefined && targetData === undefined
      ? ({ code: "invalid_target", message: `${targetFile} must contain a top-level object` } as const)
      : targetData && Object.hasOwn(targetData, "omo") && !input.replace
        ? ({ code: "native_omo_exists", message: `${targetFile} already contains a native omo block` } as const)
        : undefined

  const plugin = targetData ? readPluginEntries(targetData) : undefined
  const backupPath = targetText === undefined ? undefined : await availableBackupPath(targetFile, input.now, fs)
  const dedupedUnsupported = dedupeUnsupported(unsupported)
  const refusal = sourceRefusal ?? targetRefusal
  const preview: MigrationPreview = {
    version: 1,
    targetFile,
    targetExists: targetRead.status !== "missing",
    ...(targetText === undefined ? {} : { targetHash: hash(targetText) }),
    targetDiff: {
      set: ["omo"],
      removePlugins: plugin?.removals.map((item) => item.path) ?? [],
    },
    sourceFiles,
    sourceErrors,
    native: projection.native,
    normalized: projection.native,
    imported: projection.imported,
    unsupported: dedupedUnsupported,
    unsupportedPaths: dedupedUnsupported.map((item) => item.path),
    warnings: [
      ...sourceErrors.map((item) => `${item.path}: ${item.message}`),
      ...dedupedUnsupported.map((item) => `${item.path}: ${item.message}`),
    ],
    ...(plugin?.key ? { pluginKey: plugin.key } : {}),
    pluginRemovals: plugin?.removals ?? [],
    pluginPreserved: plugin?.preserved ?? [],
    ...(backupPath ? { backupPath } : {}),
    replace: Boolean(input.replace),
    ...(refusal ? { refusal } : {}),
    canApply: refusal === undefined && sourceFiles.length > 0,
  }
  return deepFreeze(preview)
}

export async function applyMigration(preview: MigrationPreview, input: Pick<MigrationInput, "fs"> = {}): Promise<MigrationResult> {
  if (preview.refusal) {
    return { ...preview, status: "refused", canApply: false, reason: preview.refusal.code }
  }
  if (!preview.canApply) {
    return { ...preview, status: "refused", canApply: false, reason: "invalid_target" }
  }

  const fs = migrationFs(input.fs)
  const currentTargetRead = await readOptional(fs, preview.targetFile)
  if (currentTargetRead.status === "error") {
    return { ...preview, status: "refused", canApply: false, reason: "target_unreadable", error: errorMessage(currentTargetRead.error) }
  }
  const currentTarget = currentTargetRead.status === "ok" ? currentTargetRead.text : undefined
  if (
    (preview.targetExists && currentTarget === undefined) ||
    (!preview.targetExists && currentTarget !== undefined) ||
    (preview.targetHash !== undefined && currentTarget !== undefined && hash(currentTarget) !== preview.targetHash)
  ) {
    return { ...preview, status: "refused", canApply: false, reason: "stale_preview" }
  }

  for (const source of preview.sourceFiles) {
    const currentSourceRead = await readOptional(fs, source.path)
    if (currentSourceRead.status === "error") {
      return {
        ...preview,
        status: "refused",
        canApply: false,
        reason: "legacy_unreadable",
        error: errorMessage(currentSourceRead.error),
      }
    }
    if (currentSourceRead.status === "missing" || hash(currentSourceRead.text) !== source.hash) {
      return { ...preview, status: "refused", canApply: false, reason: "stale_preview" }
    }
  }

  const targetParsed = parseLegacy(currentTarget ?? "{}")
  if (targetParsed.errors.length || !isRecord(targetParsed.value)) {
    return { ...preview, status: "refused", canApply: false, reason: "invalid_target" }
  }

  let updated = currentTarget ?? "{}"
  let writtenBackupPath = preview.backupPath
  try {
    writtenBackupPath =
      currentTarget === undefined
        ? undefined
        : await availableBackupPath(preview.targetFile, undefined, fs, preview.backupPath)
    if (currentTarget !== undefined && writtenBackupPath) await fs.writeFile(writtenBackupPath, currentTarget)
    const plugin = readPluginEntries(targetParsed.value)
    if (plugin?.key) {
      for (const item of plugin.removals.toReversed()) {
        updated = applyEdits(
          updated,
          modify(updated, [plugin.key, item.index], undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }),
        )
      }
    }
    updated = applyEdits(
      updated,
      modify(updated, ["omo"], preview.native, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )

    const temporary = `${preview.targetFile}.omo-migration-${process.pid}-${randomUUID()}.tmp`
    try {
      await fs.mkdir(path.dirname(preview.targetFile))
      await fs.writeFile(temporary, updated)
      await fs.rename(temporary, preview.targetFile)
    } catch (error) {
      await fs.rm(temporary).catch(() => {})
      return {
        ...preview,
        ...(writtenBackupPath ? { backupPath: writtenBackupPath } : { backupPath: undefined }),
        status: "failed",
        canApply: false,
        reason: "write_failed",
        error: errorMessage(error),
      }
    }
  } catch (error) {
    return {
      ...preview,
      ...(writtenBackupPath ? { backupPath: writtenBackupPath } : { backupPath: undefined }),
      status: "failed",
      canApply: false,
      reason: "write_failed",
      error: errorMessage(error),
    }
  }

  return {
    ...preview,
    ...(writtenBackupPath ? { backupPath: writtenBackupPath } : { backupPath: undefined }),
    status: "applied",
    canApply: false,
  }
}

export async function runMigration(input: MigrationInput & { apply?: boolean }): Promise<MigrationResult> {
  const preview = await planMigration(input)
  if (!input.apply) return { ...preview, status: "preview" }
  return applyMigration(preview, input)
}

function projectLegacy(raw: Record<string, unknown>) {
  const native: Record<string, unknown> = {}
  const imported: string[] = []
  const unsupported: UnsupportedField[] = []
  const addUnsupported = (field: string, message = "not supported by native OMO migration") => {
    unsupported.push({ path: field, message })
  }
  const addImported = (field: string) => {
    if (!imported.includes(field)) imported.push(field)
  }

  const preset = raw.preset
  if (preset !== undefined) {
    if (isPreset(preset)) {
      native.preset = preset
      addImported("preset")
    } else addUnsupported("preset", "preset must be auto, openai, or opencode-go")
  }

  for (const key of ["enabled", "background", "routing", "verification"] as const) {
    if (!Object.hasOwn(raw, key)) continue
    if (isSupportedScalar(key, raw[key])) {
      native[key] = raw[key]
      addImported(key)
    } else addUnsupported(key, `${key} has an unsupported value`)
  }

  const agents: Record<string, Record<string, unknown>> = {}
  const selectedPreset = isPreset(preset) ? preset : undefined
  if (selectedPreset && selectedPreset !== "auto") {
    const presetAgents = ConfigOmo.PresetAgents[selectedPreset]
    for (const [agent, value] of Object.entries(presetAgents)) {
      if (agent === "observer") continue
      agents[agent] = { ...value }
    }
  }

  const presets = raw.presets
  if (presets !== undefined) {
    if (!isRecord(presets)) addUnsupported("presets", "presets must be an object")
    else if (selectedPreset === undefined) {
      for (const name of Object.keys(presets)) addUnsupported(`presets.${name}`, "preset is not selected")
    } else {
      const selected = presets[selectedPreset]
      if (selected !== undefined && !isRecord(selected)) addUnsupported(`presets.${selectedPreset}`, "preset must be an object")
      if (isRecord(selected)) readAgentMap(selected, `presets.${selectedPreset}`, agents, addImported, addUnsupported)
      for (const name of Object.keys(presets)) {
        if (name !== selectedPreset) addUnsupported(`presets.${name}`, "only the active preset is migrated")
      }
    }
  }

  if (Object.hasOwn(raw, "agents")) {
    if (!isRecord(raw.agents)) addUnsupported("agents", "agents must be an object")
    else readAgentMap(raw.agents, "agents", agents, addImported, addUnsupported)
  }
  if (Object.keys(agents).length > 0) native.agents = agents

  if (Object.hasOwn(raw, "disabled_agents")) {
    if (!Array.isArray(raw.disabled_agents)) addUnsupported("disabled_agents", "disabled_agents must be an array")
    else {
      const disabled: string[] = []
      raw.disabled_agents.forEach((value, index) => {
        const sourcePath = `disabled_agents.${typeof value === "string" ? value : index}`
        if (typeof value !== "string") return addUnsupported(sourcePath, "disabled agent must be a string")
        const agent = normalizeAgent(value)
        if (!agent || !isAgentID(agent) || agent === "orchestrator") {
          return addUnsupported(sourcePath, agent === "orchestrator" ? "orchestrator cannot be disabled while OMO is enabled" : "unknown OMO agent")
        }
        if (!disabled.includes(agent)) disabled.push(agent)
        addImported(sourcePath)
      })
      native.disabled_agents = disabled
    }
  }

  const recognized = new Set([
    "enabled",
    "preset",
    "presets",
    "agents",
    "disabled_agents",
    "background",
    "routing",
    "verification",
  ])
  for (const key of Object.keys(raw)) {
    if (!recognized.has(key)) addUnsupported(key)
  }

  return {
    native: native as ConfigOmo.Info,
    imported,
    unsupported,
  }
}

function readAgentMap(
  input: Record<string, unknown>,
  prefix: string,
  target: Record<string, Record<string, unknown>>,
  addImported: (path: string) => void,
  addUnsupported: (path: string, message?: string) => void,
) {
  for (const [sourceAgent, rawAgent] of Object.entries(input)) {
    const agent = normalizeAgent(sourceAgent)
    if (!agent || !isAgentID(agent)) {
      addUnsupported(`${prefix}.${sourceAgent}`, "unknown OMO agent")
      continue
    }
    if (!isRecord(rawAgent)) {
      addUnsupported(`${prefix}.${sourceAgent}`, "agent override must be an object")
      continue
    }
    const targetAgent = (target[agent] ??= {})
    for (const key of Object.keys(rawAgent)) {
      const value = rawAgent[key]
      const field = `${prefix}.${sourceAgent}.${key}`
      if (key === "model") {
        if (typeof value === "string" && isModelRef(value)) {
          targetAgent.model = value.trim()
          addImported(field)
        } else addUnsupported(field, "model must use provider/model syntax")
        continue
      }
      if (key === "variant") {
        if (typeof value === "string" && value.trim()) {
          targetAgent.variant = value.trim()
          addImported(field)
        } else addUnsupported(field, "variant must be a non-empty string")
        continue
      }
      if (key === "permission") {
        if (isRecord(value)) {
          targetAgent.permission = { ...value }
          addImported(field)
        } else addUnsupported(field, "permission must be an object")
        continue
      }
      addUnsupported(field)
    }
  }
}

function mergeLegacy(sources: readonly Record<string, unknown>[]) {
  return sources.reduce<Record<string, unknown>>((result, source) => {
    for (const [key, value] of Object.entries(source)) {
      if ((key === "agents" || key === "presets") && isRecord(result[key]) && isRecord(value)) {
        result[key] = mergeNested(result[key], value)
        continue
      }
      result[key] = value
    }
    return result
  }, {})
}

function mergeNested(left: Record<string, unknown>, right: Record<string, unknown>) {
  const result = { ...left }
  for (const [key, value] of Object.entries(right)) {
    if (isRecord(result[key]) && isRecord(value)) result[key] = { ...result[key], ...value }
    else result[key] = value
  }
  return result
}

type DiscoveredSource = { path: string; scope: "global" | "project" }
type DiscoveryResult = { files: DiscoveredSource[]; errors: MigrationSourceError[] }

async function discoverLegacyFilesWithFs(input: MigrationInput, fs: Required<MigrationFs>): Promise<DiscoveryResult> {
  const globalConfigDir = path.resolve(input.globalConfigDir ?? Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config)
  const projectRoot = path.resolve(input.projectDir ?? input.cwd ?? process.cwd())
  const global = await existingLegacyFiles(globalConfigDir, "global", fs)
  const project = await findProjectLegacyFiles(projectRoot, fs)
  return {
    files: [...global.files, ...project.files],
    errors: [...global.errors, ...project.errors],
  }
}

async function existingLegacyFiles(directory: string, scope: "global" | "project", fs: Required<MigrationFs>) {
  const files: string[] = []
  const errors: MigrationSourceError[] = []
  for (const name of LEGACY_FILE_NAMES) {
    const file = path.join(directory, name)
    try {
      if (await fs.exists(file)) files.push(file)
    } catch (error) {
      errors.push({ path: file, scope, code: "legacy_unreadable", message: errorMessage(error) })
    }
  }
  return {
    files: files.map((file) => ({ path: file, scope })),
    errors,
  }
}

async function findProjectLegacyFiles(start: string, fs: Required<MigrationFs>): Promise<DiscoveryResult> {
  const directories: string[] = []
  let current = start
  while (true) {
    directories.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const files: DiscoveredSource[] = []
  const errors: MigrationSourceError[] = []
  for (const directory of directories.toReversed()) {
    const direct = await existingLegacyFiles(directory, "project", fs)
    const nested = await existingLegacyFiles(path.join(directory, ".opencode"), "project", fs)
    files.push(...direct.files, ...nested.files)
    errors.push(...direct.errors, ...nested.errors)
  }
  return { files, errors }
}

async function defaultTargetFile(directory: string, fs: Required<MigrationFs>) {
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((name) => path.resolve(directory, name))
  for (const candidate of candidates) {
    try {
      if (await fs.exists(candidate)) return { path: candidate }
    } catch (error) {
      return { path: candidate, error }
    }
  }
  return { path: candidates[0] }
}

function parseLegacy(source: string) {
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true })
  return { value, errors }
}

function readPluginEntries(input: Record<string, unknown>) {
  const key = Array.isArray(input.plugin) ? "plugin" : Array.isArray(input.plugins) ? "plugins" : undefined
  if (!key) return undefined
  const values = input[key] as unknown[]
  const removals: PluginRemoval[] = []
  const preserved: unknown[] = []
  values.forEach((value, index) => {
    if (isLegacyPluginEntry(value)) removals.push({ path: `${key}[${index}]`, index, value })
    else preserved.push(value)
  })
  return { key: key as "plugin" | "plugins", removals, preserved }
}

function isLegacyPluginEntry(input: unknown) {
  const packageName =
    typeof input === "string"
      ? input
      : Array.isArray(input) && typeof input[0] === "string"
        ? input[0]
        : isRecord(input) && typeof input.package === "string"
          ? input.package
          : undefined
  return packageName === "oh-my-opencode-slim" || packageName === "oh-my-opencode-slim@2.2.22"
}

function normalizeAgent(input: string) {
  const normalized = AGENT_ALIASES.get(input) ?? input
  return isAgentID(normalized) ? normalized : undefined
}

function isAgentID(input: string): input is ConfigOmo.AgentID {
  return AGENT_IDS.has(input)
}

function isPreset(input: unknown): input is NativePreset {
  return typeof input === "string" && (NATIVE_PRESETS as readonly string[]).includes(input)
}

function isSupportedScalar(key: "enabled" | "background" | "routing" | "verification", value: unknown) {
  if (key === "enabled") return typeof value === "boolean"
  if (key === "background") return value === "auto" || value === "allow" || value === "deny"
  if (key === "routing") return value === "auto" || value === "deterministic" || value === "semif"
  return value === "none" || value === "tests" || value === "oracle" || value === "observer"
}

function isModelRef(input: string) {
  const value = input.trim()
  const slash = value.indexOf("/")
  return slash > 0 && slash < value.length - 1 && !/[\\\s]/.test(value)
}

function migrationBackupPath(targetFile: string, now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-")
  return `${targetFile}.omo-migration-${timestamp}.bak`
}

async function availableBackupPath(targetFile: string, now: Date | undefined, fs: Required<MigrationFs>, preferred?: string) {
  const base = preferred ?? migrationBackupPath(targetFile, now)
  if (!(await fs.exists(base))) return base
  let index = 1
  while (await fs.exists(`${base}.${index}`)) index += 1
  return `${base}.${index}`
}

function migrationFs(input: MigrationFs = {}): Required<MigrationFs> {
  return {
    readFile: input.readFile ?? (async (file) => readFile(file, "utf8")),
    writeFile: input.writeFile ?? (async (file, data) => writeFile(file, data)),
    mkdir: input.mkdir ?? (async (directory) => mkdir(directory, { recursive: true }).then(() => undefined)),
    rename: input.rename ?? (async (from, to) => rename(from, to)),
    rm: input.rm ?? (async (file) => rm(file, { force: true }).then(() => undefined)),
    exists: input.exists ?? exists,
  }
}

type FileReadResult =
  | { status: "missing" }
  | { status: "ok"; text: string }
  | { status: "error"; error: unknown }

async function readOptional(fs: Required<MigrationFs>, file: string): Promise<FileReadResult> {
  let present: boolean
  try {
    present = await fs.exists(file)
  } catch (error) {
    return { status: "error", error }
  }
  if (!present) return { status: "missing" }
  try {
    return { status: "ok", text: await fs.readFile(file) }
  } catch (error) {
    return isMissingError(error) ? { status: "missing" } : { status: "error", error }
  }
}

function isMissingError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function exists(file: string) {
  return existsSync(file)
}

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function dedupeUnsupported(items: readonly UnsupportedField[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.path}\u0000${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  Object.freeze(input)
  for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value)
  return input
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
