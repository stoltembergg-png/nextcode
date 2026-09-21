import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
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
})
