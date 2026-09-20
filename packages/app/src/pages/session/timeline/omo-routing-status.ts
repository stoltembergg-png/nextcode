import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"
import type { Omo } from "@opencode-ai/schema/omo"
import type { OmoRoutingEvent } from "@opencode-ai/schema/omo-routing-event"

export function specialistLabel(agent: Omo.AgentID) {
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

export function routingStatusLabel(
  activity: OmoRoutingEvent.OmoRoutingActivity,
  t: (key: UiI18nKey, params?: UiI18nParams) => string,
) {
  const state = activity.state
  switch (state.phase) {
    case "analyzing":
      return t("ui.sessionTurn.status.semifAnalyzing")
    case "selected":
      switch (state.source) {
        case "semif":
          return t("ui.sessionTurn.status.specialistSelected", { agent: specialistLabel(state.agent) })
        case "deterministic":
          return t("ui.sessionTurn.status.deterministicRouting", { agent: specialistLabel(state.agent) })
        case "explicit":
          return t("ui.sessionTurn.status.specialistSpecified", { agent: specialistLabel(state.agent) })
      }
    case "delegating":
      return t(
        state.background
          ? "ui.sessionTurn.status.startingSpecialistBackground"
          : "ui.sessionTurn.status.startingSpecialist",
        { agent: specialistLabel(state.agent) },
      )
    case "cleared":
      return
  }
}
