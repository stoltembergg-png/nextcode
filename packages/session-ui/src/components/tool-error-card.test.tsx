import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { ToolErrorCard } from "./tool-error-card"

const i18n: UiI18n = {
  locale: () => "en",
  t: (key) => en[key] ?? key,
  plural: (key, count) => (en[`${key}.other`] ?? key).replaceAll("{{count}}", String(count)),
}

describe("ToolErrorCard", () => {
  test("trigger uses icon title and subtitle slots", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <I18nProvider value={i18n}>
          <ToolErrorCard tool="read" error="Error: ENOENT: no such file" subtitle="secret.ts" />
        </I18nProvider>
      ),
      host,
    )
    const trigger = host.querySelector('[data-component="tool-trigger"]')
    expect(trigger?.querySelector('[data-slot="basic-tool-tool-icon"]')).toBeTruthy()
    expect(trigger?.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toContain("Read")
    expect(trigger?.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent).toContain("secret.ts")
    dispose()
    host.remove()
  })
})
