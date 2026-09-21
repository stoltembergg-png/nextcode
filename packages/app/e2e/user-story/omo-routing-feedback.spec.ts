import { base64Encode } from "@opencode-ai/core/util/encode"
import type { OmoRoutingEvent } from "@opencode-ai/schema/omo-routing-event"
import { expect, test, type Page } from "@playwright/test"
import { mockNextCodeServer } from "../utils/mock-server"
import { installSseTransport, type SseConnectionRecord } from "../utils/sse-transport"

const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const directory = "C:/NextCode/OmoRoutingFeedback"
const projectID = "proj_omo_routing_feedback"
const sessionA = { id: "ses_omo_routing_feedback_a", title: "OMO routing feedback A" }
const sessionB = { id: "ses_omo_routing_feedback_b", title: "OMO routing feedback B" }

type RoutingEnvelope = {
  directory: string
  payload: {
    id: string
    type: "session.omo.routing"
    properties: OmoRoutingEvent.OmoRoutingActivity
  }
}

type StatusEnvelope = {
  directory: string
  payload: {
    id: string
    type: "session.status"
    properties: { sessionID: string; status: { type: "idle" } }
  }
}

test.use({ viewport: { width: 1440, height: 900 } })

test("shows the acknowledged SemIf routing phases before returning to generic thinking", async ({ page }) => {
  const fixture = await setup(page)
  const thinking = thinkingLabel(page)

  await fixture.send(routing(sessionA.id, "call_semif", { phase: "analyzing" }, 0))
  await expect(thinking).toContainText("SemIf analyzing")

  await fixture.send(
    routing(
      sessionA.id,
      "call_semif",
      { phase: "selected", agent: "fixer", source: "semif", background: false, verification: "tests", durationMs: 40 },
      1,
    ),
  )
  await expect(thinking).toContainText("Specialist selected: Fixer")

  await fixture.send(
    routing(sessionA.id, "call_semif", { phase: "delegating", agent: "fixer", source: "semif", background: false }, 2),
  )
  await expect(thinking).toContainText("Starting Fixer")

  await fixture.send(routing(sessionA.id, "call_semif", { phase: "cleared" }, 3))
  await expect(thinking).toHaveText("Thinking")
})

test("uses truthful deterministic and explicit labels without claiming SemIf", async ({ page }) => {
  const fixture = await setup(page)
  const thinking = thinkingLabel(page)

  await fixture.send(
    routing(
      sessionA.id,
      "call_deterministic",
      {
        phase: "selected",
        agent: "fixer",
        source: "deterministic",
        background: false,
        verification: "tests",
        durationMs: 0,
      },
      0,
    ),
  )
  await expect(thinking).toHaveText("Deterministic routing · Fixer")
  await expect(thinking).not.toContainText("SemIf")

  await fixture.send(
    routing(
      sessionA.id,
      "call_explicit",
      {
        phase: "selected",
        agent: "oracle",
        source: "explicit",
        background: false,
        verification: "oracle",
        durationMs: 0,
      },
      0,
      1_700_000_000_001,
    ),
  )
  await expect(thinking).toHaveText("Specialist specified: Oracle")
  await expect(thinking).not.toContainText("SemIf")
})

test("keeps a cleared routing activity generic when a stale event arrives", async ({ page }) => {
  const fixture = await setup(page)
  const thinking = thinkingLabel(page)

  await fixture.send(
    routing(
      sessionA.id,
      "call_stale",
      { phase: "selected", agent: "fixer", source: "semif", background: false, verification: "tests", durationMs: 40 },
      2,
    ),
  )
  await expect(thinking).toHaveText("Specialist selected: Fixer")
  await fixture.send(routing(sessionA.id, "call_stale", { phase: "cleared" }, 3))
  await expect(thinking).toHaveText("Thinking")
  await fixture.send(
    routing(
      sessionA.id,
      "call_stale",
      {
        phase: "selected",
        agent: "oracle",
        source: "semif",
        background: false,
        verification: "oracle",
        durationMs: 20,
      },
      2,
    ),
  )
  await expect(thinking).toHaveText("Thinking")
  await expect(thinking).not.toContainText("Specialist")
})

test("clears volatile routing activity on reconnect before accepting a new event", async ({ page }) => {
  const fixture = await setup(page)
  const thinking = thinkingLabel(page)

  await fixture.send(
    routing(
      sessionA.id,
      "call_before_reconnect",
      { phase: "selected", agent: "fixer", source: "semif", background: false, verification: "tests", durationMs: 40 },
      0,
    ),
  )
  await expect(thinking).toHaveText("Specialist selected: Fixer")

  await fixture.transport.close()
  const connection = await fixture.transport.waitForConnection({ after: fixture.connection.id })
  await expect(thinking).toHaveText("Thinking")

  await fixture.send(
    routing(
      sessionA.id,
      "call_after_reconnect",
      {
        phase: "selected",
        agent: "oracle",
        source: "explicit",
        background: false,
        verification: "oracle",
        durationMs: 0,
      },
      0,
    ),
    connection,
  )
  await expect(thinking).toHaveText("Specialist specified: Oracle")
})

test("reveals the older active call after clearing the newest call", async ({ page }) => {
  const fixture = await setup(page)
  const thinking = thinkingLabel(page)

  await fixture.send(
    routing(
      sessionA.id,
      "call_older",
      {
        phase: "selected",
        agent: "fixer",
        source: "deterministic",
        background: false,
        verification: "tests",
        durationMs: 0,
      },
      0,
      100,
    ),
  )
  await expect(thinking).toHaveText("Deterministic routing · Fixer")
  await fixture.send(
    routing(
      sessionA.id,
      "call_newer",
      {
        phase: "selected",
        agent: "oracle",
        source: "explicit",
        background: false,
        verification: "oracle",
        durationMs: 0,
      },
      0,
      200,
    ),
  )
  await expect(thinking).toHaveText("Specialist specified: Oracle")
  await fixture.send(routing(sessionA.id, "call_newer", { phase: "cleared" }, 1, 201))
  await expect(thinking).toHaveText("Deterministic routing · Fixer")
})

test("isolates live routing activity to the tab that owns its session", async ({ page }) => {
  const fixture = await setup(page, [sessionA, sessionB])
  const thinking = thinkingLabel(page)
  const hrefB = sessionHref(sessionB.id)

  await fixture.send(
    routing(
      sessionB.id,
      "call_session_b",
      {
        phase: "selected",
        agent: "oracle",
        source: "explicit",
        background: false,
        verification: "oracle",
        durationMs: 0,
      },
      0,
    ),
  )
  await expect(thinking).toHaveText("Thinking")
  await expect(thinking).not.toContainText("Oracle")

  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`).click()
  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
  await expect(thinking).toHaveText("Specialist specified: Oracle")
})

test("removes the thinking row when cancellation makes the session idle", async ({ page }) => {
  const fixture = await setup(page)
  const thinking = thinkingLabel(page)

  await fixture.send(routing(sessionA.id, "call_cancelled", { phase: "analyzing" }, 0))
  await expect(thinking).toHaveText("SemIf analyzing")
  await fixture.send({
    directory,
    payload: {
      id: "evt_omo_routing_feedback_idle",
      type: "session.status",
      properties: { sessionID: sessionA.id, status: { type: "idle" } },
    },
  })
  await expect(thinking).toHaveCount(0)
})

async function setup(page: Page, sessions = [sessionA]) {
  const transport = await installSseTransport<RoutingEnvelope | StatusEnvelope>(page, { server, retry: 20 })
  await mockNextCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "omo-routing-feedback",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "NextCode",
          models: {
            "omo-routing-feedback": {
              id: "omo-routing-feedback",
              name: "OMO routing feedback",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "omo-routing-feedback" },
    },
    sessions: sessions.map((item) => session(item)),
    sessionStatus: Object.fromEntries(sessions.map((item) => [item.id, { type: "busy" }])),
    pageMessages: (sessionID) => ({ items: messages(sessionID) }),
  })
  await page.addInitScript(
    ({ sessions }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true, showStatus: true, showSessionProgressBar: true } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessions.map((item: { id: string }) => ({ type: "session", server, sessionId: item.id }))),
      )
    },
    { sessions },
  )
  await page.goto(sessionHref(sessionA.id))
  const connection = await transport.waitForConnection()
  await expect(page).toHaveURL(new RegExp(`${sessionHref(sessionA.id)}$`))
  await expect(thinkingLabel(page)).toHaveText("Thinking")

  return {
    transport,
    connection,
    async send(event: RoutingEnvelope | StatusEnvelope, connectionRecord: SseConnectionRecord = connection) {
      const acknowledgement = await transport.send(event)
      expect(acknowledgement.connectionID).toBe(connectionRecord.id)
    },
  }
}

function routing(
  sessionID: string,
  toolCallID: string,
  state: OmoRoutingEvent.OmoRoutingActivity["state"],
  sequence: number,
  updatedAt = 1_700_000_000_000 + sequence,
): RoutingEnvelope {
  return {
    directory,
    payload: {
      id: `evt_omo_routing_feedback_${sessionID}_${toolCallID}_${sequence}`,
      type: "session.omo.routing",
      properties: {
        sessionID,
        assistantMessageID: assistantID(sessionID),
        toolCallID,
        sequence,
        startedAt: 1_700_000_000_000,
        updatedAt,
        state,
      },
    },
  }
}

function session(input: { id: string; title: string }) {
  return {
    id: input.id,
    slug: input.id,
    projectID,
    directory,
    title: input.title,
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

function messages(sessionID: string) {
  const userID = `msg_omo_routing_feedback_user_${sessionID}`
  return [
    {
      info: { id: userID, sessionID, role: "user", time: { created: 1_700_000_000_000 }, agent: "build" },
      parts: [{ id: `prt_${userID}`, sessionID, messageID: userID, type: "text", text: "Route this active turn." }],
    },
    {
      info: {
        id: assistantID(sessionID),
        sessionID,
        role: "assistant",
        parentID: userID,
        time: { created: 1_700_000_000_100 },
        agent: "build",
        modelID: "omo-routing-feedback",
        providerID: "opencode",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    },
  ]
}

function assistantID(sessionID: string) {
  return `msg_omo_routing_feedback_assistant_${sessionID}`
}

function sessionHref(sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

function thinkingLabel(page: Page) {
  return page.locator('[data-slot="thinking-status-label"] [data-slot="text-shimmer-char-base"]')
}
