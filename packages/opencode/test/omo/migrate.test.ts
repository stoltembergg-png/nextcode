import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import {
  applyMigration,
  planMigration,
  type MigrationPreview,
} from "../../src/omo/migrate"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nextcode-omo-migration-"))
  roots.push(root)
  const globalConfigDir = path.join(root, "global")
  const projectDir = path.join(root, "project")
  await Promise.all([mkdir(globalConfigDir, { recursive: true }), mkdir(projectDir, { recursive: true })])
  await Promise.all([
    writeFile(
      path.join(globalConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify(
        {
          preset: "openai",
          presets: {
            openai: {
              orchestrator: { model: "openai/gpt-5.6-terra", variant: "high" },
              fixer: { model: "openai/gpt-5.6-luna", variant: "high" },
            },
          },
          agents: {
            fixer: { variant: "medium", permission: { edit: "allow" } },
          },
          disabled_agents: ["librarian"],
          council: { enabled: true },
        },
        null,
        2,
      ),
    ),
    writeFile(
      path.join(projectDir, "oh-my-opencode-slim.jsonc"),
      `{
  // local OMO settings
  "agents": { "oracle": { "model": "openai/gpt-5.6-sol" } },
  "verification": "tests"
}
`,
    ),
    writeFile(
      path.join(globalConfigDir, "opencode.jsonc"),
      `{
  // Keep this comment and unrelated settings.
  "model": "anthropic/claude-sonnet-4",
  "plugin": [
    "oh-my-opencode-slim",
    "oh-my-opencode-slim@2.2.22",
    "oh-my-opencode-slim@2.2.21",
    "other-plugin",
    "https://example.test/oh-my-opencode-slim",
    "./oh-my-opencode-slim",
    "my-oh-my-opencode-slim"
  ]
}
`,
    ),
  ])
  return {
    root,
    globalConfigDir,
    projectDir,
    targetFile: path.join(globalConfigDir, "opencode.jsonc"),
  }
}

describe("native OMO migration planner", () => {
  test("discovers global and project JSON/JSONC and returns a dry-run preview", async () => {
    const input = await fixture()
    const preview = await planMigration(input)

    expect(preview.sourceFiles.map((file) => file.path)).toEqual([
      path.join(input.globalConfigDir, "oh-my-opencode-slim.json"),
      path.join(input.projectDir, "oh-my-opencode-slim.jsonc"),
    ])
    expect(preview.native).toMatchObject({
      preset: "openai",
      disabled_agents: ["librarian"],
      verification: "tests",
      agents: {
        orchestrator: { model: "openai/gpt-5.6-terra", variant: "high" },
        fixer: { model: "openai/gpt-5.6-luna", variant: "medium", permission: { edit: "allow" } },
        oracle: { model: "openai/gpt-5.6-sol" },
      },
    })
    expect(preview.unsupportedPaths).toContain("council")
    expect(preview.pluginRemovals.map((item) => item.value)).toEqual(["oh-my-opencode-slim", "oh-my-opencode-slim@2.2.22"])
    expect(preview.canApply).toBe(true)
    expect(await readFile(input.targetFile, "utf8")).toContain("oh-my-opencode-slim@2.2.22")
    expect(preview.backupPath).toContain(".omo-migration-")
  })

  test("reports path-qualified unsupported fields and preserves exact plugin lookalikes", async () => {
    const input = await fixture()
    await writeFile(
      path.join(input.globalConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        preset: "custom",
        agents: { explorer: { inheritModelFrom: "session", temperature: 0.2 }, unknown: { model: "x/y" } },
        disabled_agents: ["orchestrator", "unknown"],
      }),
    )

    const preview = await planMigration(input)

    expect(preview.unsupportedPaths).toEqual(
      expect.arrayContaining([
        "preset",
        "agents.explorer.inheritModelFrom",
        "agents.explorer.temperature",
        "agents.unknown",
        "disabled_agents.orchestrator",
        "disabled_agents.unknown",
      ]),
    )
    expect(preview.pluginRemovals).toHaveLength(2)
    expect(preview.pluginPreserved).toEqual([
      "oh-my-opencode-slim@2.2.21",
      "other-plugin",
      "https://example.test/oh-my-opencode-slim",
      "./oh-my-opencode-slim",
      "my-oh-my-opencode-slim",
    ])
  })

  test("backs up exact bytes, patches only native OMO and plugin entries, and retains legacy files", async () => {
    const input = await fixture()
    const before = await readFile(input.targetFile, "utf8")
    const preview = await planMigration({ ...input, now: new Date("2026-09-19T12:34:56.000Z") })
    const result = await applyMigration(preview)

    expect(result.status).toBe("applied")
    expect(result.backupPath).toBe(preview.backupPath)
    expect(await readFile(preview.backupPath!, "utf8")).toBe(before)
    const target = await readFile(input.targetFile, "utf8")
    expect(target).toContain("Keep this comment")
    expect(target).toContain('"model": "anthropic/claude-sonnet-4"')
    expect(target).toContain('"other-plugin"')
    expect(target).toContain("https://example.test/oh-my-opencode-slim")
    expect(target).not.toContain("oh-my-opencode-slim@2.2.22")
    expect(target).not.toContain('"oh-my-opencode-slim"')
    expect(target).toContain('"omo"')
    expect(await readFile(path.join(input.globalConfigDir, "oh-my-opencode-slim.json"), "utf8")).toContain('"council"')
    expect(await readFile(path.join(input.projectDir, "oh-my-opencode-slim.jsonc"), "utf8")).toContain("local OMO")
  })

  test("refuses an existing native block unless replacement is explicit", async () => {
    const input = await fixture()
    await writeFile(input.targetFile, '{\n  "omo": { "preset": "auto" },\n  "model": "x/y"\n}\n')

    const preview = await planMigration(input)
    expect(preview.refusal?.code).toBe("native_omo_exists")
    expect((await applyMigration(preview)).status).toBe("refused")

    const replace = await planMigration({ ...input, replace: true, now: new Date("2026-09-19T12:34:56.000Z") })
    expect(replace.refusal).toBeUndefined()
    expect((await applyMigration(replace)).status).toBe("applied")
    expect(await readFile(replace.backupPath!, "utf8")).toContain('"preset": "auto"')
  })

  test("refuses stale previews before creating a backup", async () => {
    const input = await fixture()
    const preview = await planMigration(input)
    await writeFile(input.targetFile, `${await readFile(input.targetFile, "utf8")}\n`)

    const result = await applyMigration(preview)

    expect(result.status).toBe("refused")
    expect(result.reason).toBe("stale_preview")
    expect(preview.backupPath ? await Bun.file(preview.backupPath).exists() : false).toBe(false)
  })

  test("creates a missing native target without deleting legacy sources", async () => {
    const input = await fixture()
    await rm(input.targetFile)
    const preview = await planMigration(input)

    expect(preview.targetExists).toBe(false)
    expect(preview.backupPath).toBeUndefined()
    expect((await applyMigration(preview)).status).toBe("applied")
    expect(await readFile(input.targetFile, "utf8")).toContain('"omo"')
    expect(await readFile(path.join(input.globalConfigDir, "oh-my-opencode-slim.json"), "utf8")).toContain('"preset"')
  })

  test("does not mutate the target when the target write cannot complete", async () => {
    const input = await fixture()
    const before = await readFile(input.targetFile, "utf8")
    const preview = await planMigration(input)
    const result = await applyMigration(preview, {
      fs: {
        readFile: (file) => readFile(file, "utf8"),
        writeFile: async (file: string, data: string | Uint8Array) => {
          if (file.includes(".omo-migration-") && file.endsWith(".tmp")) throw new Error("injected target write failure")
          await writeFile(file, data)
        },
      },
    })

    expect(result.status).toBe("failed")
    expect(await readFile(input.targetFile, "utf8")).toBe(before)
  })
})

void (undefined as unknown as MigrationPreview)
