import { describe, expect, test } from "bun:test"
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"
import type { OmoRoutingEvent } from "@opencode-ai/schema/omo-routing-event"
import { routingStatusLabel } from "./omo-routing-status"

const t = (key: UiI18nKey, params?: UiI18nParams) => `${key}:${params?.agent ?? ""}`

const activity = (state: OmoRoutingEvent.OmoRoutingActivity["state"]): OmoRoutingEvent.OmoRoutingActivity =>
  ({
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    toolCallID: "call_1",
    sequence: 0,
    startedAt: 0,
    updatedAt: 0,
    state,
  }) as OmoRoutingEvent.OmoRoutingActivity

describe("routingStatusLabel", () => {
  test("maps every routing phase to truthful status text", () => {
    expect(routingStatusLabel(activity({ phase: "analyzing" }), t)).toBe("ui.sessionTurn.status.semifAnalyzing:")
    expect(
      routingStatusLabel(
        activity({
          phase: "selected",
          agent: "fixer",
          source: "semif",
          background: false,
          verification: "tests",
          durationMs: 40,
        }),
        t,
      ),
    ).toBe("ui.sessionTurn.status.specialistSelected:Fixer")
    expect(
      routingStatusLabel(
        activity({
          phase: "selected",
          agent: "fixer",
          source: "deterministic",
          background: false,
          verification: "tests",
          durationMs: 40,
        }),
        t,
      ),
    ).toBe("ui.sessionTurn.status.deterministicRouting:Fixer")
    expect(
      routingStatusLabel(
        activity({
          phase: "selected",
          agent: "fixer",
          source: "explicit",
          background: false,
          verification: "tests",
          durationMs: 40,
        }),
        t,
      ),
    ).toBe("ui.sessionTurn.status.specialistSpecified:Fixer")
    expect(
      routingStatusLabel(
        activity({ phase: "delegating", agent: "fixer", source: "semif", background: false }),
        t,
      ),
    ).toBe("ui.sessionTurn.status.startingSpecialist:Fixer")
    expect(
      routingStatusLabel(
        activity({ phase: "delegating", agent: "fixer", source: "semif", background: true }),
        t,
      ),
    ).toBe("ui.sessionTurn.status.startingSpecialistBackground:Fixer")
    expect(routingStatusLabel(activity({ phase: "cleared" }), t)).toBeUndefined()
  })

  test("ships the approved English and Brazilian Portuguese labels", async () => {
    const enPath = "../../../../../ui/src/i18n/en"
    const brPath = "../../../../../ui/src/i18n/br"
    const [{ dict: en }, { dict: br }] = await Promise.all([import(enPath), import(brPath)])
    const expected = {
      "ui.sessionTurn.status.semifAnalyzing": ["SemIf analyzing", "SemIf analisando"],
      "ui.sessionTurn.status.specialistSelected": ["Specialist selected: {{agent}}", "Especialista selecionado: {{agent}}"],
      "ui.sessionTurn.status.deterministicRouting": ["Deterministic routing · {{agent}}", "Roteamento determinístico · {{agent}}"],
      "ui.sessionTurn.status.specialistSpecified": ["Specialist specified: {{agent}}", "Especialista definido: {{agent}}"],
      "ui.sessionTurn.status.startingSpecialist": ["Starting {{agent}}", "Iniciando {{agent}}"],
      "ui.sessionTurn.status.startingSpecialistBackground": [
        "Starting {{agent}} in the background",
        "Iniciando {{agent}} em segundo plano",
      ],
    } as const

    Object.entries(expected).forEach(([key, [english, portuguese]]) => {
      expect(en[key as keyof typeof en]).toBe(english)
      expect(br[key as keyof typeof br]).toBe(portuguese)
    })
  })
})
