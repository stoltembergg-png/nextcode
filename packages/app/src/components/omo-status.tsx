import type { OmoStatus } from "@opencode-ai/sdk/v2/client"
import { Match, Show, Switch, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"

export type OmoStatusView = {
  state: "loading" | "failed" | "conflict" | "disabled" | "ready" | "fallback"
  preset?: OmoStatus["preset"]
  agentCount: number
  source?: "semif" | "deterministic"
  failure?: string
  plugin?: string
}

export function omoStatusView(input: {
  status?: OmoStatus
  loading?: boolean
  failed?: boolean
}): OmoStatusView {
  if (input.loading) return { state: "loading", agentCount: 0 }
  if (input.failed || !input.status) return { state: "failed", agentCount: 0 }

  const status = input.status
  const base = {
    preset: status.preset,
    agentCount: status.agents.length,
    ...(status.last_failure ? { failure: status.last_failure } : {}),
  } satisfies Omit<OmoStatusView, "state" | "source" | "plugin">

  if (status.conflict.active) return { ...base, state: "conflict", plugin: status.conflict.plugin }
  if (!status.enabled) return { ...base, state: "disabled" }
  if (status.semif.status === "ready") return { ...base, state: "ready", source: "semif" }
  return { ...base, state: "fallback", source: "deterministic" }
}

export function OmoStatusSection(props: {
  status: () => OmoStatus | undefined
  loading: () => boolean
  failed: () => boolean
}) {
  const language = useLanguage()
  const view = createMemo(() => omoStatusView({ status: props.status(), loading: props.loading(), failed: props.failed() }))

  return (
    <div data-component="omo-status" data-state={view().state} class="flex flex-col px-2 pb-2">
      <div class="flex flex-col gap-3 p-3 bg-background-base rounded-sm min-h-14">
        <div class="flex flex-col gap-0.5 min-w-0">
          <span class="text-14-regular text-text-base">{language.t("status.popover.tab.omo")}</span>
          <span class="text-12-regular text-text-weak">{language.t("omo.status.description")}</span>
        </div>

        <Switch>
          <Match when={view().state === "loading"}>
            <div class="text-12-regular text-text-weak">{language.t("omo.status.loading")}</div>
          </Match>
          <Match when={view().state === "failed"}>
            <div class="text-12-regular text-text-weak">{language.t("omo.status.failed")}</div>
          </Match>
          <Match when={view().state === "conflict"}>
            <div class="flex flex-col gap-2 rounded-md border border-icon-warning-base/40 bg-surface-inset-base p-2">
              <span class="text-12-medium text-text-base">{language.t("omo.status.conflict.title")}</span>
              <span class="text-12-regular text-text-weak">{language.t("omo.status.conflict.description")}</span>
              <code class="text-11-regular text-text-base">omo migrate</code>
              <Show when={view().plugin}>
                {(plugin) => <span class="text-11-regular text-text-weaker">{plugin()}</span>}
              </Show>
            </div>
          </Match>
          <Match when={view().state === "disabled"}>
            <div class="text-12-regular text-text-weak">{language.t("omo.status.disabled")}</div>
          </Match>
          <Match when={view().state === "ready" || view().state === "fallback"}>
            <div class="flex flex-col gap-2 text-12-regular">
              <div class="flex items-center justify-between gap-3">
                <span class="text-text-weak">{language.t("omo.status.preset")}</span>
                <span class="text-text-base">{view().preset}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-text-weak">{language.t("omo.status.agents")}</span>
                <span class="text-text-base">{view().agentCount}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-text-weak">{language.t("omo.status.routing")}</span>
                <span class="text-text-base">
                  {language.t(view().source === "semif" ? "omo.status.routing.semif" : "omo.status.routing.deterministic")}
                </span>
              </div>
            </div>
          </Match>
        </Switch>

        <Show when={view().failure}>
          {(failure) => (
            <div data-slot="omo-status-failure" class="flex flex-col gap-0.5">
              <span class="text-12-regular text-text-weak">{language.t("omo.status.failure")}</span>
              <span class="text-11-regular text-text-weaker break-words">{failure()}</span>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
