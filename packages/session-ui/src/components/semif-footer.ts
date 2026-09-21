import type { UiI18nKey, UiI18nParams, UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"
import { omoDelegateView } from "./omo-delegate"

export type SemifFooterPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    metadata?: Record<string, unknown>
  }
}

export function semifFooterForPart(copyPartID: string | null | undefined, partID: string, label: string) {
  if (copyPartID !== partID) return
  return label
}

export function semifFooterLabel(input: {
  parts: readonly SemifFooterPart[]
  locale: string
  t: (key: UiI18nKey, params?: UiI18nParams) => string
  plural: (key: UiI18nPluralKey, count: number, params?: UiI18nParams) => string
}) {
  const tools = input.parts.filter((part) => part.type === "tool")
  const routed = tools.some(
    (part) => part.tool === "omo_delegate" && omoDelegateView(part.state?.metadata, part.state?.status).source === "semif",
  )
  const decisions = tools.filter((part) => part.tool === "semif_decide" && part.state?.status === "completed")
  const tokens = decisions.reduce((sum, part) => sum + localTokens(part.state?.metadata?.input_tokens), 0)
  if (!routed && decisions.length === 0) return input.t("ui.message.semif.none")
  if (decisions.length === 0) return input.t("ui.message.semif.routed")
  const phrase = `${input.t("ui.message.semif.routed")} · ${input.plural("ui.message.semif.decisions", decisions.length)}`
  if (tokens <= 0) return phrase
  return `${phrase} · ${input.t("ui.message.semif.tokens", { tokens: compactTokenCount(tokens, input.locale) })}`
}

function localTokens(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return value
}

function compactTokenCount(value: number, locale: string) {
  if (value < 1000) return Math.round(value).toString()
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}
