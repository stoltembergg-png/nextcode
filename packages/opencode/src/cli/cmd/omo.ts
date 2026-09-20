import type { Argv } from "yargs"

import {
  runMigration,
  type MigrationInput,
  type MigrationResult,
  type MigrationPreview,
} from "../../omo/migrate"
import { cmd } from "./cmd"

export type OmoMigrateArgs = {
  apply?: boolean
  replace?: boolean
  json?: boolean
}

export const OmoMigrateCommand = cmd<{}, OmoMigrateArgs>({
  command: "migrate",
  describe: "migrate oh-my-opencode-slim configuration to native OMO",
  builder: (yargs: Argv) =>
    yargs
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "apply the migration after showing the planned changes",
      })
      .option("replace", {
        type: "boolean",
        default: false,
        describe: "replace an existing native omo block (requires --apply)",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "emit the stable migration result as JSON",
      }),
  handler: async (args) => {
    const result = await runOmoMigrate(args)
    const output = args.json ? formatMigrationJson(result) : formatMigrationText(result)
    process.stdout.write(output)
    if (result.status === "failed" || result.status === "refused") process.exitCode = 1
  },
})

export const OmoCommand = cmd<{}, OmoMigrateArgs>({
  command: "omo",
  describe: "native OMO configuration and migration",
  builder: (yargs: Argv) => yargs.command(OmoMigrateCommand).demandCommand(),
  handler: async () => {},
})

export async function runOmoMigrate(args: OmoMigrateArgs, input: MigrationInput = {}): Promise<MigrationResult> {
  const validation = validateMigrationFlags(args)
  if (validation) {
    return {
      version: 1,
      status: "refused",
      targetFile: input.targetFile ?? "",
      targetExists: false,
      targetDiff: { set: [], removePlugins: [] },
      sourceFiles: [],
      native: {},
      normalized: {},
      imported: [],
      unsupported: [],
      unsupportedPaths: [],
      warnings: [],
      pluginRemovals: [],
      pluginPreserved: [],
      replace: Boolean(args.replace),
      canApply: false,
      reason: validation.code,
      error: validation.message,
    }
  }
  return runMigration({ ...input, apply: Boolean(args.apply), replace: Boolean(args.replace) })
}

export function validateMigrationFlags(args: Pick<OmoMigrateArgs, "apply" | "replace">) {
  if (args.replace && !args.apply) {
    return {
      code: "replace_requires_apply" as const,
      message: "--replace requires --apply",
    }
  }
  return undefined
}

export function formatMigrationJson(result: MigrationResult | MigrationPreview | Record<string, unknown>) {
  return `${JSON.stringify(result, null, 2)}\n`
}

type MigrationDisplay = {
  status?: unknown
  targetFile?: unknown
  imported?: unknown
  unsupported?: unknown
  pluginRemovals?: unknown
  backupPath?: unknown
  reason?: unknown
  error?: unknown
}

export function formatMigrationText(result: MigrationDisplay) {
  const targetFile = typeof result.targetFile === "string" ? result.targetFile : "(not resolved)"
  const imported = Array.isArray(result.imported) && result.imported.length > 0 ? result.imported.join(", ") : "none"
  const unsupported = Array.isArray(result.unsupported)
    ? result.unsupported
        .filter(isUnsupported)
        .map((item) => `Unsupported: ${item.path} — ${item.message}`)
        .join("\n")
    : ""
  const removals = Array.isArray(result.pluginRemovals)
    ? result.pluginRemovals
        .filter(isPluginRemoval)
        .map((item) => `Remove ${item.path}: ${formatValue(item.value)}`)
        .join("\n")
    : ""
  const lines = [
    `Status: ${typeof result.status === "string" ? result.status : "preview"}`,
    `Target: ${targetFile}`,
    `Imported: ${imported}`,
    unsupported,
    removals,
    `Backup: ${typeof result.backupPath === "string" ? result.backupPath : "none (target does not exist)"}`,
  ].filter(Boolean)
  if (typeof result.reason === "string") lines.push(`Reason: ${result.reason}`)
  if (typeof result.error === "string") lines.push(`Error: ${result.error}`)
  return `${lines.join("\n")}\n`
}

function isUnsupported(input: unknown): input is { path: string; message: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "path" in input &&
    typeof input.path === "string" &&
    "message" in input &&
    typeof input.message === "string"
  )
}

function isPluginRemoval(input: unknown): input is { path: string; value: unknown } {
  return typeof input === "object" && input !== null && "path" in input && typeof input.path === "string" && "value" in input
}

function formatValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value)
}
