import { afterEach, describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { createPromptInputV2InteractionState } from "./machine"
import type { PromptInputV2Interaction } from "./interaction"

mock.module("@opencode-ai/ui/v2/menu-v2", async () => {
  const { DropdownMenu } = await import("@kobalte/core/dropdown-menu")
  return {
    MenuV2: Object.assign(DropdownMenu, {
      Trigger: DropdownMenu.Trigger,
      Portal: DropdownMenu.Portal,
      Content: DropdownMenu.Content,
      Item: DropdownMenu.Item,
      CheckboxItem: DropdownMenu.CheckboxItem,
      RadioGroup: DropdownMenu.RadioGroup,
      RadioItem: DropdownMenu.RadioItem,
      Group: DropdownMenu.Group,
      GroupLabel: DropdownMenu.GroupLabel,
      Separator: DropdownMenu.Separator,
      Sub: DropdownMenu.Sub,
      SubTrigger: DropdownMenu.SubTrigger,
      SubContent: DropdownMenu.SubContent,
    }),
  }
})

const { PromptInputV2 } = await import("./index")
import type { PromptInputV2Props } from "./index"

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

const i18n: UiI18n = {
  locale: () => "en",
  t: (key) => en[key] ?? key,
  plural: (key, count) => (en[`${key}.other`] ?? key).replaceAll("{{count}}", String(count)),
}

function renderPrompt(props?: Pick<PromptInputV2Props, "strip">) {
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
        <PromptInputV2 controller={controller} strip={props?.strip} />
      </I18nProvider>
    ),
    host,
  )
  cleanups.push(() => {
    dispose()
    host.remove()
  })
  return host
}

describe("PromptInputV2", () => {
  test("composer card is compact and send uses IconButtonV2", () => {
    const root = renderPrompt()
    const form = root.querySelector("[data-component='prompt-input-v2']")
    expect(form?.className).not.toContain("min-h-[96px]")
    const toolbar = form?.querySelector("[data-slot='prompt-toolbar']")
    expect(toolbar?.className).not.toContain("h-11")
    expect(root.querySelector("[data-action='prompt-submit']")?.getAttribute("data-component")).toBe("icon-button-v2")
  })

  test("strip is absent when omitted", () => {
    const root = renderPrompt()
    expect(root.querySelector("[data-slot='prompt-strip']")).toBeNull()
  })

  test("strip shows the label and hides the body until expanded", () => {
    const root = renderPrompt({
      strip: { label: "1 of 3 todos completed", expanded: false, onToggle() {}, body: <div data-slot="strip-body" /> },
    })
    expect(root.querySelector("[data-slot='prompt-strip']")?.textContent).toContain("1 of 3 todos completed")
    expect(root.querySelector("[data-slot='strip-body']")).toBeNull()
  })
})
