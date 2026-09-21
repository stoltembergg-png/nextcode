import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OmoRoutingEvent } from "../src/omo-routing-event"

const base = {
  sessionID: "ses_feedback",
  assistantMessageID: "msg_feedback",
  toolCallID: "call_feedback",
  sequence: 0,
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

describe("OMO routing activity event", () => {
  test("is live-only and accepts all bounded phases", () => {
    expect(OmoRoutingEvent.Updated.durable).toBeUndefined()
    const decode = Schema.decodeUnknownSync(OmoRoutingEvent.Updated.data)
    expect(decode({ ...base, state: { phase: "analyzing" } }).state.phase).toBe("analyzing")
    expect(
      decode({
        ...base,
        sequence: 1,
        state: {
          phase: "selected",
          agent: "fixer",
          source: "semif",
          background: false,
          verification: "tests",
          durationMs: 42,
        },
      }).state.phase,
    ).toBe("selected")
    expect(
      decode({
        ...base,
        sequence: 2,
        state: { phase: "delegating", agent: "fixer", source: "semif", background: false },
      }).state.phase,
    ).toBe("delegating")
    expect(decode({ ...base, sequence: 3, state: { phase: "cleared" } }).state.phase).toBe("cleared")
  })

  test("rejects unbounded routing data", () => {
    const decode = Schema.decodeUnknownSync(OmoRoutingEvent.Updated.data, { onExcessProperty: "error" })
    expect(() => decode({ ...base, state: { phase: "analyzing" }, prompt: "secret" })).toThrow()
    expect(() =>
      decode({
        ...base,
        state: {
          phase: "selected",
          agent: "unknown",
          source: "semif",
          background: false,
          verification: "tests",
          durationMs: 10,
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...base,
        state: {
          phase: "selected",
          agent: "fixer",
          source: "unknown",
          background: false,
          verification: "tests",
          durationMs: 10,
        },
      }),
    ).toThrow()
    expect(() => decode({ ...base, state: { phase: "routing" } })).toThrow()
  })
})
