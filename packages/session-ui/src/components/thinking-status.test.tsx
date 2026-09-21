import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { I18nProvider, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { ThinkingStatus } from "./thinking-status"

const i18n: UiI18n = {
  locale: () => "en",
  t: (key) => en[key] ?? key,
  plural: (key, count) => (en[`${key}.other`] ?? key).replaceAll("{{count}}", String(count)),
}

describe("thinking activity row", () => {
  test("pending thinking label shimmers and body stays inside the collapsible", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <I18nProvider value={i18n}>
          <ThinkingStatus active pendingMessage={undefined} parts={[]}>
            <div data-slot="thinking-body">because the file is stale</div>
          </ThinkingStatus>
        </I18nProvider>
      ),
      host,
    )
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toContain("Thinking")
    expect(host.querySelector('[data-slot="thinking-body"]')).toBeTruthy()
    expect(host.querySelector('[data-component="reasoning-part"]')).toBeNull()
    dispose()
    host.remove()
  })

  test("completed thought row freezes elapsed from message completion, not wall clock", () => {
    const now = Date.now()
    const created = now - 2 * 60 * 60 * 1000
    const completed = created + 5_000
    const pendingMessage: AssistantMessage = {
      id: "msg_thought",
      sessionID: "ses_1",
      role: "assistant",
      time: { created, completed },
      parentID: "msg_user",
      modelID: "model",
      providerID: "provider",
      mode: "agent",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <I18nProvider value={i18n}>
          <ThinkingStatus active={false} pendingMessage={pendingMessage} parts={[]} />
        </I18nProvider>
      ),
      host,
    )
    const elapsed = host.querySelector('[data-slot="thinking-status-stat-elapsed"]')
    expect(elapsed?.textContent).toContain("5")
    expect(elapsed?.textContent).not.toContain("7200")
    dispose()
    host.remove()
  })
})
