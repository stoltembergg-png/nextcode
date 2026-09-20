import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { Config } from "../../src/config/config"
import { OmoObservability } from "../../src/omo/observability"
import { OmoRouter, OmoRoutingCancelled, type OmoRoutingRequest } from "../../src/omo/router"
import { generateStrategies } from "../../src/omo/strategy"
import { SemifService, SemifServiceError, type SemifStatus, type Status } from "../../src/semif/service"
import type { SemifDecision, SemifDecisionRequest } from "../../src/semif/scoring"
import { testEffect } from "../lib/effect"

type Calls = {
  status: number
  start: number
  acquire: number
  decide: number
  requests: SemifDecisionRequest[]
}

const it = testEffect(Layer.empty)

const ready: Status = status("ready")

const baseRequest: OmoRoutingRequest = {
  summary: "Implement a focused code change and verify it with tests",
  evidence: ["The parser currently rejects the valid input"],
  eligibleAgents: ["explore", "oracle", "fixer"] as const,
  backgroundAvailable: true,
  backgroundPolicy: "allow" as const,
  availableVerification: ["none", "tests", "oracle"] as const,
}

function status(value: SemifStatus, mode: Status["mode"] = "auto"): Status {
  return {
    status: value,
    mode,
    download: "auto",
    backend: "cpu",
    backendRequested: "auto",
    backendFallback: false,
    systemRuntimeMissing: false,
    choices: [],
    host: "127.0.0.1",
    port: 8817,
    adopted: false,
  }
}

function decision(request: SemifDecisionRequest, chosen = request.options[0]?.id): SemifDecision {
  const optionIds = request.options.map((option) => option.id)
  return {
    id: "decision-1",
    option_ids: optionIds,
    probabilities: optionIds.map((_, index) => (index === 0 ? 0.8 : 0.2 / Math.max(1, optionIds.length - 1))),
    option_logits: optionIds.map((_, index) => -index),
    answer_token_ids: optionIds.map((_, index) => index + 1),
    chosen: chosen ?? "",
    input_tokens: 8,
    prompt_sha256: "sha256",
    prompt_version: "direct-options-v1",
    model: { source: "test", revision: "test", server: "test" },
    probability_status: "conditional option score; uncalibrated as decision confidence",
    readout: "test",
    forward_seconds: 0,
    total_seconds: 0,
    missing_slots: [],
  }
}

function calls(): Calls {
  return { status: 0, start: 0, acquire: 0, decide: 0, requests: [] }
}

function fakeSemif(
  counts: Calls,
  current: Status,
  decide: SemifService.Interface["decide"] = (request) => Effect.succeed(decision(request)),
  start: SemifService.Interface["start"] = () => Effect.succeed(current),
): SemifService.Interface {
  return {
    status: () => Effect.sync(() => ((counts.status += 1), current)),
    statusReadOnly: () => Effect.succeed(current),
    start: () => Effect.sync(() => (counts.start += 1)).pipe(Effect.andThen(start())),
    acquire: () =>
      Effect.sync(() => (counts.acquire += 1)).pipe(
        Effect.andThen(Effect.fail(new SemifServiceError({ reason: "acquire must not run" }))),
      ),
    decide: (request) =>
      Effect.sync(() => {
        counts.decide += 1
        counts.requests.push(request)
      }).pipe(Effect.andThen(decide(request))),
    dispose: () => Effect.void,
  }
}

function routerLayer(semif: SemifService.Interface, config: ConfigV1.Info = {}) {
  const router = LayerNode.compile(LayerNode.group([OmoRouter.node, OmoObservability.node, Config.node]), [
    [SemifService.node, Layer.succeed(SemifService.Service, SemifService.Service.of(semif))],
    [Config.node, Layer.mock(Config.Service)({ get: () => Effect.succeed(config) })],
  ])
  return router
}

function route(request = baseRequest) {
  return Effect.gen(function* () {
    const router = yield* OmoRouter.Service
    return yield* router.route(request)
  })
}

describe("native OMO SemIf routing", () => {
  it.live("calls decide exactly once when SemIf is ready and only sends eligible option IDs", () =>
    Effect.gen(function* () {
      const counts = calls()
      const result = yield* route().pipe(
        Effect.provide(routerLayer(fakeSemif(counts, ready))),
      )

      expect(counts.status).toBe(1)
      expect(counts.start).toBe(0)
      expect(counts.acquire).toBe(0)
      expect(counts.decide).toBe(1)
      expect(counts.requests[0]?.options.map((option) => option.id)).toEqual(
        generateStrategies({
          eligibleAgents: baseRequest.eligibleAgents!,
          background: { available: true, policy: "allow" },
          verification: baseRequest.availableVerification!,
        }).map((strategy) => strategy.id),
      )
      expect(result.source).toBe("semif")
      expect(result.alternatives.every((item) => counts.requests[0]!.options.some((option) => option.id === item.id))).toBe(true)
    }),
  )

  for (const state of [
    "disabled",
    "unsupported",
    "not_downloaded",
    "downloading",
    "verifying",
    "starting",
    "failed",
    "offline",
  ] as const) {
    it.live(`falls back immediately while SemIf is ${state}`, () =>
      Effect.gen(function* () {
        const counts = calls()
        const result = yield* route().pipe(
          Effect.provide(routerLayer(fakeSemif(counts, status(state)))),
        )

        expect(result.source).toBe("deterministic")
        expect(result.fallbackReason).toContain("semif")
        expect(counts.decide).toBe(0)
        expect(counts.acquire).toBe(0)
      }),
    )
  }

  it.live("forks lazy preparation without awaiting start", () =>
    Effect.gen(function* () {
      const counts = calls()
      const started = yield* Deferred.make<void>()
      const result = yield* route().pipe(
        Effect.provide(
          routerLayer(
            fakeSemif(counts, status("not_downloaded", "lazy"), undefined, () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        ),
      )

      expect(result.source).toBe("deterministic")
      expect(counts.decide).toBe(0)
      expect(counts.acquire).toBe(0)
      yield* Deferred.await(started)
      expect(counts.start).toBe(1)
    }),
  )

  it.live("skips SemIf entirely for the deterministic policy", () =>
    Effect.gen(function* () {
      const counts = calls()
      const result = yield* route({
        ...baseRequest,
        config: { routing: "deterministic" },
      }).pipe(Effect.provide(routerLayer(fakeSemif(counts, ready))))

      expect(result.source).toBe("deterministic")
      expect(counts.status).toBe(0)
      expect(counts.start).toBe(0)
      expect(counts.acquire).toBe(0)
      expect(counts.decide).toBe(0)
    }),
  )

  it.live("skips SemIf when only one strategy is eligible", () =>
    Effect.gen(function* () {
      const counts = calls()
      const result = yield* route({
        summary: "Run the focused check",
        eligibleAgents: ["fixer"],
        backgroundAvailable: false,
        availableVerification: ["none"],
      }).pipe(Effect.provide(routerLayer(fakeSemif(counts, ready))))

      expect(result.source).toBe("deterministic")
      expect(result.agent).toBe("fixer")
      expect(result.background).toBe(false)
      expect(result.verification).toBe("none")
      expect(counts.status).toBe(0)
      expect(counts.start).toBe(0)
      expect(counts.acquire).toBe(0)
      expect(counts.decide).toBe(0)
    }),
  )

  it.live("reads omo routing policy from the legacy Config service", () =>
    Effect.gen(function* () {
      const counts = calls()
      const config = { omo: { routing: "deterministic" } } satisfies ConfigV1.Info
      const result = yield* route({ ...baseRequest }).pipe(Effect.provide(routerLayer(fakeSemif(counts, ready), config)))

      expect(result.source).toBe("deterministic")
      expect(counts.status).toBe(0)
      expect(counts.decide).toBe(0)
    }),
  )

  it.live("uses configured omo verification as the default without overriding an explicit request", () =>
    Effect.gen(function* () {
      const counts = calls()
      const config = { omo: { verification: "tests" } } satisfies ConfigV1.Info
      const result = yield* route({ ...baseRequest }).pipe(
        Effect.provide(routerLayer(fakeSemif(counts, ready), config)),
      )

      expect(result.verification).toBe("tests")
      expect(counts.requests[0]?.options.every((option) => option.id.endsWith(":tests"))).toBe(true)
    }),
  )

  it.live("propagates timeout cancellation to the SemIf decision signal", () =>
    Effect.gen(function* () {
      const counts = calls()
      const interrupted = yield* Deferred.make<void>()
      let decisionSignal: AbortSignal | undefined
      const semif = fakeSemif(counts, ready, (request) => {
        decisionSignal = request.signal
        return Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined)))
      })
      const result = yield* route({ ...baseRequest, timeoutMs: 5 }).pipe(Effect.provide(routerLayer(semif)))

      yield* Deferred.await(interrupted)
      expect(result.source).toBe("deterministic")
      expect(decisionSignal?.aborted).toBe(true)
      expect(counts.decide).toBe(1)
    }),
  )

  for (const [name, output, reason] of [
    ["timeout", () => Effect.never, "timed out"],
    ["malformed output", () => Effect.succeed(undefined as unknown as SemifDecision), "malformed"],
    ["missing answer slots", (request: SemifDecisionRequest) => Effect.succeed({ ...decision(request), missing_slots: ["B"] }), "missing"],
    ["ineligible choice", (request: SemifDecisionRequest) => Effect.succeed({ ...decision(request), chosen: "not-eligible" }), "ineligible"],
    ["ordinary SemIf error", () => Effect.fail(new SemifServiceError({ reason: "semif failed\nC:\\private\\secret" })), "failed"],
  ] as const) {
    it.live(`normalizes ${name} into deterministic fallback`, () =>
      Effect.gen(function* () {
        const counts = calls()
        const result = yield* route({ ...baseRequest, timeoutMs: name === "timeout" ? 5 : undefined }).pipe(
          Effect.provide(routerLayer(fakeSemif(counts, ready, output))),
        )

        expect(result.source).toBe("deterministic")
        expect(result.fallbackReason?.toLowerCase()).toContain(reason)
        expect(counts.decide).toBe(1)
        expect(counts.acquire).toBe(0)
      }),
    )
  }

  it.live("normalizes a SemIf-only policy failure without failing the session", () =>
    Effect.gen(function* () {
      const counts = calls()
      const result = yield* route({
        ...baseRequest,
        config: { routing: "semif" },
      }).pipe(Effect.provide(routerLayer(fakeSemif(counts, status("failed")))))

      expect(result.source).toBe("deterministic")
      expect(result.fallbackReason).toContain("failed")
      expect(counts.decide).toBe(0)
      expect(counts.acquire).toBe(0)
    }),
  )

  it.live("rejects malformed missing_slots and incomplete decision records", () =>
    Effect.gen(function* () {
      const missingSlotsShape = calls()
      const malformedSlots = yield* route({ ...baseRequest }).pipe(
        Effect.provide(
          routerLayer(
            fakeSemif(missingSlotsShape, ready, (request) =>
              Effect.succeed({ ...decision(request), missing_slots: "B" } as unknown as SemifDecision),
            ),
          ),
        ),
      )
      expect(malformedSlots.source).toBe("deterministic")

      const incomplete = calls()
      const missingModel = yield* route({ ...baseRequest }).pipe(
        Effect.provide(
          routerLayer(
            fakeSemif(incomplete, ready, (request) => {
              const value = decision(request) as unknown as Record<string, unknown>
              delete value.model
              return Effect.succeed(value as unknown as SemifDecision)
            }),
          ),
        ),
      )
      expect(missingModel.source).toBe("deterministic")
    }),
  )

  it.live("applies explicit fields while retaining SemIf fields not overridden", () =>
    Effect.gen(function* () {
      const counts = calls()
      const semif = fakeSemif(counts, ready, (request) => {
        const selected = request.options.find((option) => option.id === "fixer:background:tests")
        return Effect.succeed(decision(request, selected?.id))
      })
      const result = yield* route({
        ...baseRequest,
        explicit: { agent: "fixer" },
      }).pipe(Effect.provide(routerLayer(semif)))

      expect(result).toMatchObject({ agent: "fixer", background: true, verification: "tests", source: "explicit" })
      expect(counts.requests[0]?.options.every((option) => option.id.startsWith("fixer:"))).toBe(true)
    }),
  )

  it.live("does not treat intentional deterministic routing as a SemIf failure", () =>
    Effect.gen(function* () {
      const counts = calls()
      const result = yield* Effect.gen(function* () {
        const router = yield* OmoRouter.Service
        const recommendation = yield* router.route({ ...baseRequest, config: { routing: "deterministic" } })
        const observability = yield* OmoObservability.Service
        return {
          recommendation,
          latest: yield* observability.last(),
          failure: yield* observability.lastFailure(),
        }
      }).pipe(Effect.provide(routerLayer(fakeSemif(counts, ready))))

      expect(result.recommendation.source).toBe("deterministic")
      expect(result.latest?.source).toBe("deterministic")
      expect(result.failure).toBeUndefined()
      expect(counts.status).toBe(0)
      expect(counts.decide).toBe(0)
    }),
  )

  it.live("cancels in-flight routing instead of converting cancellation to success", () =>
    Effect.gen(function* () {
      const counts = calls()
      const entered = yield* Deferred.make<void>()
      const controller = new AbortController()
      const semif = fakeSemif(counts, ready, () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const fiber = yield* route({ ...baseRequest, signal: controller.signal }).pipe(
        Effect.provide(routerLayer(semif)),
        Effect.forkScoped,
      )
      yield* Deferred.await(entered)
      controller.abort(new Error("user stopped routing"))
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(OmoRoutingCancelled)
      expect(counts.decide).toBe(1)
      expect(counts.requests[0]?.signal?.aborted).toBe(true)
    }),
  )

  it.live("records bounded, sanitized metadata without task content", () =>
    Effect.gen(function* () {
      const counts = calls()
      const longEvidence = `${"sensitive evidence ".repeat(100)} C:\\private\\secret.txt\n`
      const result = yield* Effect.gen(function* () {
        const router = yield* OmoRouter.Service
        const result = yield* router.route({
          ...baseRequest,
          summary: `${"private prompt ".repeat(100)} /home/user/secret`,
          evidence: [longEvidence],
        })
        const observation = yield* (yield* OmoObservability.Service).last()
        return { result, observation }
      }).pipe(Effect.provide(routerLayer(fakeSemif(counts, status("offline")))))

      expect(result.result.fallbackReason?.length).toBeLessThanOrEqual(160)
      expect(Number.isFinite(result.result.alternatives[0]?.score)).toBe(true)
      expect(JSON.stringify(result.observation)).not.toContain("private prompt")
      expect(JSON.stringify(result.observation)).not.toContain("secret.txt")
      expect(result.result).not.toHaveProperty("summary")
      expect(result.result).not.toHaveProperty("evidence")
      expect(result.result.alternatives.length).toBeLessThanOrEqual(16)
    }),
  )
})
