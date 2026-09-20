import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockNextCodeServer } from "../utils/mock-server"

const directory = "C:/NextCode/OmoConflictDiagnosis"
const projectID = "proj_omo_conflict_diagnosis"
const sessionID = "ses_omo_conflict_session_01"
const sessionTitle = "OMO conflict diagnosis"
const legacyPlugin = "oh-my-opencode-slim-legacy-omo"

test.use({ viewport: { width: 1440, height: 900 } })

test("diagnoses legacy OMO conflict and shows suppressed native registration", async ({ page }) => {
  await mockNextCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "omo-conflict-diagnosis",
      time: { created: 1_700_000_100_000, updated: 1_700_000_100_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "NextCode",
          models: {
            "omo-conflict-model": { id: "omo-conflict-model", name: "OMO conflict model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "omo-conflict-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: sessionTitle,
        version: "dev",
        time: { created: 1_700_000_100_000, updated: 1_700_000_100_000 },
        agent: "build",
      },
    ],
    pageMessages: () => ({ items: [] }),
    omo: {
      agents: [],
      status: {
        enabled: true,
        preset: "auto",
        agents: [],
        semif: { status: "ready", mode: "auto" },
        conflict: { active: true, plugin: legacyPlugin },
      },
    },
  })
  await configurePage(page)

  await page.goto(sessionHref(sessionID))
  await expect(page.getByRole("heading", { name: sessionTitle })).toBeVisible()

  await page.getByRole("button", { name: "Status" }).click()
  await page.getByRole("tab", { name: "OMO", exact: true }).click()

  const status = page.locator('[data-component="omo-status"]')
  await expect(status).toHaveAttribute("data-state", "conflict")
  await expect(status).toContainText("Legacy OMO plugin detected")
  await expect(status).toContainText("Native registration is suppressed")
  await expect(status).toContainText("omo migrate")
  await expect(status).toContainText(legacyPlugin)
  await expect(status).not.toContainText("fixer")
})

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, showStatus: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionID }]))
    },
    { directory, server, sessionID },
  )
}

function sessionHref(id: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${id}`
}
