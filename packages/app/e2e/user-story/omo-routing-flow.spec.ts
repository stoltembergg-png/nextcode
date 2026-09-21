import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockNextCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/NextCode/OmoRoutingFlow"
const projectID = "proj_omo_routing_flow"
const parentID = "ses_omo_routing_parent_01"
const childID = "ses_omo_routing_child_01"
const parentTitle = "OMO routing flow"
const childTitle = "OMO specialist child"

test.use({ viewport: { width: 1440, height: 900 } })

test("shows native OMO routing provenance, lifecycle states, agent selection, and child navigation", async ({ page }) => {
  await mockNextCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "omo-routing-flow",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "NextCode",
          models: {
            "omo-flow-model": { id: "omo-flow-model", name: "OMO flow model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "omo-flow-model" },
    },
    sessions: [
      session(parentID, parentTitle, 1_700_000_000_000),
      session(childID, childTitle, 1_700_000_001_000, { parentID }),
    ],
    pageMessages: (sessionID) => ({ items: sessionID === parentID ? parentMessages() : [] }),
    omo: {
      agents: [
        agent("orchestrator", "primary"),
        agent("fixer", "subagent"),
        agent("oracle", "subagent"),
      ],
      status: {
        enabled: true,
        preset: "auto",
        agents: ["orchestrator", "fixer", "oracle"],
        semif: { status: "ready", mode: "auto" },
        conflict: { active: false },
      },
      childSessions: (sessionID) => (sessionID === parentID ? [currentSession(session(childID, childTitle, 1_700_000_001_000, { parentID }))] : []),
      delegateParts: (sessionID) => (sessionID === parentID ? delegateParts() : []),
    },
  })
  await configurePage(page)

  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  const agentControl = page.getByRole("button", { name: "Choose agent" }).filter({ hasText: /orchestrator/i })
  await expect(agentControl).toBeVisible()
  await expect(agentControl).toContainText(/orchestrator/i)

  const readyCard = page.getByRole("link", { name: /fixer Agent.*Foreground.*Completed.*Routed by SemIf/i })
  await expect(readyCard).toBeVisible()
  await expect(readyCard).toContainText("Foreground")
  await expect(readyCard).toContainText("Completed")
  await expect(readyCard).toContainText("Child session")
  await expect(readyCard).toHaveAttribute("href", new RegExp(`${childID}$`))

  const fallbackCard = page.getByRole("link", { name: /oracle Agent.*deterministic routing/i })
  await expect(fallbackCard).toBeVisible()
  await expect(fallbackCard).toContainText("Fallback: SemIf unavailable")

  await expect(page.getByRole("link", { name: /fixer Agent.*Background.*Running/i })).toBeVisible()
  await expect(page.getByRole("link", { name: /oracle Agent.*Background.*Completed/i })).toBeVisible()

  const statusButton = page.getByRole("button", { name: "Status" })
  await statusButton.click()
  await page.getByRole("tab", { name: "OMO", exact: true }).click()
  const status = page.locator('[data-component="omo-status"]')
  await expect(status).toHaveAttribute("data-state", "ready")
  await expect(status).toContainText("Native OMO routing and delegation")
  await expect(status).toContainText("SemIf")
  await expect(status).toContainText("3")

  await readyCard.click()
  await expect(page).toHaveURL(new RegExp(`/session/${childID}$`))
  await expectSessionTitle(page, childTitle)
})

function agent(name: string, mode: "primary" | "subagent") {
  return {
    id: name,
    name,
    mode,
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
  }
}

function session(id: string, title: string, created: number, extra?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
    ...extra,
  }
}

function currentSession(value: ReturnType<typeof session>) {
  return {
    id: value.id,
    parentID: value.parentID,
    projectID,
    directory,
    title: value.title,
    agent: "orchestrator",
    model: { providerID: "opencode", modelID: "omo-flow-model" },
    time: value.time,
  }
}

function parentMessages() {
  const userID = "msg_omo_routing_user_01"
  const assistantID = "msg_omo_routing_assistant_01"
  return [
    {
      info: {
        id: userID,
        sessionID: parentID,
        role: "user",
        time: { created: 1_700_000_000_000 },
      },
      parts: [{ id: "prt_omo_routing_prompt_01", type: "text", text: "Route this work through the native OMO boundary" }],
    },
    {
      info: {
        id: assistantID,
        sessionID: parentID,
        role: "assistant",
        time: { created: 1_700_000_000_100, completed: 1_700_000_004_000 },
        agent: "orchestrator",
        modelID: "omo-flow-model",
        providerID: "opencode",
      },
      parts: [],
    },
  ]
}

function delegateParts() {
  const time = { start: 1_700_000_001_000, end: 1_700_000_002_000 }
  return [
    delegatePart("prt_omo_foreground_01", "fixer", "completed", false, "semif", undefined, time),
    delegatePart("prt_omo_fallback_01", "oracle", "completed", false, "deterministic", "SemIf unavailable", time),
    delegatePart("prt_omo_background_running_01", "fixer", "running", true, "semif", undefined, time),
    delegatePart("prt_omo_background_completed_01", "oracle", "completed", true, "semif", undefined, time),
  ]
}

function delegatePart(
  id: string,
  agentName: string,
  state: "running" | "completed",
  background: boolean,
  source: "semif" | "deterministic",
  fallbackReason: string | undefined,
  time: { start: number; end: number },
) {
  return {
    id,
    sessionID: parentID,
    messageID: "msg_omo_routing_assistant_01",
    type: "tool",
    callID: `call_${id}`,
    tool: "omo_delegate",
    state: {
      status: state,
      input: { description: `${agentName} routing`, background },
      output: state === "completed" ? "Native OMO turn admitted" : undefined,
      metadata: {
        child_id: childID,
        state,
        agent: agentName,
        background,
        source,
        verification: "tests",
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      },
      time,
    },
  }
}

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
    { directory, server, sessionID: parentID },
  )
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
