import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SemifObserve } from "@opencode-ai/core/session/semif-observe"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(SemifObserve.noop)

describe("SemifObserve", () => {
  it.effect("noop observe succeeds without changing the value", () =>
    Effect.gen(function* () {
      const observe = yield* SemifObserve.Service
      yield* observe.observeCompact({
        sessionID: SessionSchema.ID.make("ses_test"),
        actual: "continue",
        evidence: "tokens=1",
        tokensBefore: 100,
        tokensAfterIfCompact: 40,
      })
    }),
  )
})
