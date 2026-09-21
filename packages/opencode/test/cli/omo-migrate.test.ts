import { describe, expect, test } from "bun:test"
import {
  OmoCommand,
  OmoMigrateCommand,
  formatMigrationJson,
  formatMigrationText,
  validateMigrationFlags,
} from "../../src/cli/cmd/omo"

describe("omo migrate CLI", () => {
  test("registers the nested command and rejects --replace without --apply", () => {
    expect(OmoCommand.command).toBe("omo")
    expect(OmoMigrateCommand.command).toBe("migrate")
    expect(validateMigrationFlags({ apply: false, replace: true })).toMatchObject({ code: "replace_requires_apply" })
    expect(validateMigrationFlags({ apply: true, replace: true })).toBeUndefined()
  })

  test("formats a stable JSON result and human preview with required migration details", () => {
    const result = {
      status: "preview" as const,
      targetFile: "C:/config/opencode.jsonc",
      imported: ["preset", "agents.fixer.model"],
      unsupported: [{ path: "council", message: "not supported" }],
      pluginRemovals: [{ path: "plugin[0]", value: "oh-my-opencode-slim@2.2.22" }],
      backupPath: "C:/config/opencode.jsonc.omo-migration-123.bak",
    }

    expect(formatMigrationJson(result)).toBe(`${JSON.stringify(result, null, 2)}\n`)
    const text = formatMigrationText(result)
    expect(text).toContain("Target: C:/config/opencode.jsonc")
    expect(text).toContain("Imported: preset, agents.fixer.model")
    expect(text).toContain("Unsupported: council — not supported")
    expect(text).toContain("Remove plugin[0]: oh-my-opencode-slim@2.2.22")
    expect(text).toContain("Backup: C:/config/opencode.jsonc.omo-migration-123.bak")
  })

  test("prints refusal details in the human preview", () => {
    const text = formatMigrationText({
      status: "preview",
      targetFile: "C:/config/opencode.jsonc",
      imported: [],
      unsupported: [],
      pluginRemovals: [],
      refusal: { code: "legacy_unreadable", message: "legacy file denied" },
    })

    expect(text).toContain("Refusal: legacy_unreadable — legacy file denied")
  })
})
