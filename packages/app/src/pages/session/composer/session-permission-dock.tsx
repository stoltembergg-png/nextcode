import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <div data-slot="permission-request" class="flex flex-col gap-3">
      <Show when={toolDescription()}>
        <div class="text-14-regular text-text-weak">{toolDescription()}</div>
      </Show>
      <Show when={props.request.patterns.length > 0}>
        <div class="flex flex-col gap-1.5">
          <For each={props.request.patterns}>
            {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
          </For>
        </div>
      </Show>
      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
          {language.t("ui.permission.deny")}
        </Button>
        <Button variant="secondary" size="normal" onClick={() => props.onDecide("always")} disabled={props.responding}>
          {language.t("ui.permission.allowAlways")}
        </Button>
        <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
          {language.t("ui.permission.allowOnce")}
        </Button>
      </div>
    </div>
  )
}
