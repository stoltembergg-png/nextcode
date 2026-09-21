import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { createPromptInputV2InteractionState } from "./machine"
import { PromptInputV2 } from "./index"
import type { PromptInputV2Interaction } from "./interaction"

const i18n: UiI18n = {
  locale: () => "en",
  t: (key) => en[key] ?? key,
  plural: (key, count) => (en[`${key}.other`] ?? key).replaceAll("{{count}}", String(count)),
}

function renderPrompt() {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const noop = () => {}
  const stub = {
    state: createPromptInputV2InteractionState(),
    view: {
      submit: {
        stopping: () => false,
        onSubmit: noop,
        onStop: noop,
      },
    },
    suggestions: () => [],
    dispatch: () => false,
    onKeyDown: () => false,
    value: () => "",
    parts: () => [],
    attachments: () => [],
    comments: () => [],
    canSubmit: () => true,
    setFileInput: noop,
    addAttachments: noop,
    openAttachment: noop,
    removeAttachment: noop,
    toggleContext: noop,
    removeContext: noop,
    setEditor: noop,
    onInput: noop,
    onCursor: noop,
    onPaste: noop,
    attach: noop,
    openCommands: noop,
    openContext: noop,
    openShell: noop,
    submit: noop,
    stop: noop,
    onDragEnter: noop,
    onDragOver: noop,
    onDragLeave: noop,
    onDrop: noop,
    setQuery: noop,
  }
  const controller = (stub as unknown) as PromptInputV2Interaction
  const dispose = render(
    () => (
      <I18nProvider value={i18n}>
        <PromptInputV2 controller={controller} />
      </I18nProvider>
    ),
    host,
  )
  return { host, dispose }
}

describe("PromptInputV2", () => {
  test("composer card is compact and send uses IconButtonV2", () => {
    const { host: root, dispose } = renderPrompt()
    const form = root.querySelector("[data-component='prompt-input-v2']")
    expect(form?.className).not.toContain("min-h-[96px]")
    const toolbar = form?.querySelector("[data-slot='prompt-toolbar']")
    expect(toolbar?.className).not.toContain("h-11")
    expect(root.querySelector("[data-action='prompt-submit']")?.getAttribute("data-component")).toBe("icon-button-v2")
    dispose()
    root.remove()
  })
})
