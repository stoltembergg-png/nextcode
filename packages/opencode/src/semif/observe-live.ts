import { Effect, Layer } from "effect"
import { SemifObserve } from "@opencode-ai/core/session/semif-observe"
import { SemifService } from "./service"

export const layer = Layer.effect(
  SemifObserve.Service,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const semif = yield* SemifService.Service
    return SemifObserve.Service.of({
      observeCompact: (input) =>
        Effect.gen(function* () {
          const snap = yield* semif.status()
          if (snap.routing.effective === "off") return
          const decision = yield* semif
            .decide({
              id: `shadow:${input.sessionID}:continue_or_compact`,
              state: input.evidence,
              question: "Should the session compact context before the next provider turn, or continue?",
              options: [
                { id: "continue", description: "Continue without compacting." },
                { id: "compact", description: "Compact session context first." },
              ],
              signal: AbortSignal.timeout(750),
            })
            .pipe(Effect.timeout("750 millis"), Effect.orElseSucceed(() => undefined))
          if (!decision) return
          const agree = decision.chosen === input.actual
          yield* semif.rememberRouting({
            task: "continue_or_compact",
            chosen: decision.chosen,
            actual: input.actual,
            agree,
            at: Date.now(),
          })
          yield* Effect.logInfo("semif.shadow", {
            task: "continue_or_compact",
            actual: input.actual,
            chosen: decision.chosen,
            agree,
            latencyMs: Math.round(decision.total_seconds * 1000),
            hypotheticalTokensSaved:
              input.actual === "continue" && decision.chosen === "compact"
                ? Math.max(0, input.tokensBefore - input.tokensAfterIfCompact)
                : 0,
          })
        }).pipe(Effect.orElseSucceed(() => undefined), Effect.forkIn(scope), Effect.asVoid),
    })
  }),
)

export * as SemifObserveLive from "./observe-live"
