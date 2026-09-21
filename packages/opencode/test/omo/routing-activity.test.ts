import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { OmoRoutingEvent } from "@opencode-ai/schema/omo-routing-event"
import { Effect } from "effect"
import { OmoRoutingActivity } from "@/omo/routing-activity"

const sessionID = SessionSchema.ID.make("ses_omo_routing_activity")
const assistantMessageID = SessionMessage.ID.make("msg_omo_routing_activity")

describe("OMO routing activity tracker", () => {
  test("publishes sequenced, bounded lifecycle transitions", () =>
    Effect.gen(function* () {
      const published: OmoRoutingEvent.OmoRoutingActivity[] = []
      const publish: OmoRoutingActivity.Publish = (activity) =>
        Effect.sync(() => {
          published.push(activity)
        })
      const tracker = OmoRoutingActivity.makeTracker(publish, {
        sessionID,
        assistantMessageID,
        toolCallID: "call_feedback",
        startedAt: 100,
      })

      yield* tracker.analyzing()
      yield* tracker.selected({
        agent: "fixer",
        background: false,
        verification: "tests",
        source: "deterministic",
        alternatives: [],
        fallbackReason: "semif decision timed out after 750ms",
      })
      yield* tracker.delegating({ agent: "fixer", background: false, source: "deterministic" })
      yield* tracker.clear()

      expect(published.map((event) => event.sequence)).toEqual([0, 1, 2, 3])
      expect(published.map((event) => event.startedAt)).toEqual([100, 100, 100, 100])
      expect(published[1]?.state).toMatchObject({ phase: "selected", fallback: "timeout" })
      expect(published[1]?.state).toMatchObject({ durationMs: published[1]?.updatedAt - 100 })
      expect(JSON.stringify(published)).not.toContain("timed out after 750ms")
      expect(JSON.stringify(published)).not.toContain("alternatives")
    }).pipe(Effect.runPromise))

  test("ignores duplicate and stale transitions after the terminal tombstone", () =>
    Effect.gen(function* () {
      const published: OmoRoutingEvent.OmoRoutingActivity[] = []
      const tracker = OmoRoutingActivity.makeTracker(
        (activity) => Effect.sync(() => published.push(activity)),
        { sessionID, assistantMessageID, toolCallID: "call_tombstone", startedAt: 100 },
      )

      yield* tracker.analyzing()
      yield* tracker.analyzing()
      yield* tracker.clear()
      yield* tracker.clear()
      yield* tracker.selected({
        agent: "fixer",
        background: false,
        verification: "tests",
        source: "semif",
        alternatives: [],
      })

      expect(published.map((event) => event.sequence)).toEqual([0, 1])
      expect(published.map((event) => event.state.phase)).toEqual(["analyzing", "cleared"])
    }).pipe(Effect.runPromise))

  test("swallows publisher failures for every lifecycle transition", () =>
    Effect.gen(function* () {
      const tracker = OmoRoutingActivity.makeTracker(
        () => Effect.die("event transport unavailable"),
        { sessionID, assistantMessageID, toolCallID: "call_failure", startedAt: 100 },
      )

      yield* tracker.analyzing()
      yield* tracker.selected({
        agent: "fixer",
        background: false,
        verification: "tests",
        source: "semif",
        alternatives: [],
      })
      yield* tracker.delegating({ agent: "fixer", background: false, source: "semif" })
      yield* tracker.clear()
    }).pipe(Effect.runPromise))
})
