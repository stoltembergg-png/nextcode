import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { failureMessageKey, reset, retryDelay, run, shouldPrepare, shouldWarmup, type Policy } from "../../src/semif/warmup"
import type { Status } from "../../src/semif/service"

const status = (overrides: Partial<Status>): Status => ({
  status: "not_downloaded",
  mode: "auto",
  download: "auto",
  backend: "cpu",
  backendRequested: "auto",
  backendFallback: true,
  systemRuntimeMissing: false,
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices: [],
  ...overrides,
})

describe("semif warm-up policy", () => {
  test("shouldWarmup opts in only for mode=auto with download=auto", () => {
    const policies: Array<[Policy, boolean]> = [
      [{ mode: "auto", download: "auto" }, true],
      [{ mode: "auto", download: "manual" }, false],
      [{ mode: "auto", download: "never" }, false],
      [{ mode: "lazy", download: "auto" }, false],
      [{ mode: "off", download: "auto" }, false],
    ]
    for (const [policy, expected] of policies) {
      expect(shouldWarmup(policy)).toBe(expected)
    }
  })

  test("shouldPrepare defers in-flight and disabled states and respects download policy", () => {
    expect(shouldPrepare(status({ status: "downloading" }))).toBe(false)
    expect(shouldPrepare(status({ status: "verifying" }))).toBe(false)
    expect(shouldPrepare(status({ status: "starting" }))).toBe(false)
    expect(shouldPrepare(status({ status: "ready" }))).toBe(false)
    expect(shouldPrepare(status({ status: "unsupported" }))).toBe(false)
    expect(shouldPrepare(status({ status: "disabled", mode: "off" }))).toBe(false)

    expect(shouldPrepare(status({ status: "offline" }))).toBe(true)
    expect(shouldPrepare(status({ status: "failed" }))).toBe(true)
    expect(shouldPrepare(status({ status: "not_downloaded", download: "auto" }))).toBe(true)
    expect(shouldPrepare(status({ status: "not_downloaded", download: "manual" }))).toBe(false)
    expect(shouldPrepare(status({ status: "not_downloaded", download: "never" }))).toBe(false)
  })

  test("run starts only when auto+auto and never starts for off/lazy/manual/never", async () => {
    let started = 0
    const start = Effect.sync(() => {
      started += 1
    })

    await Effect.runPromise(run({ mode: "auto", download: "auto" }, start))
    expect(started).toBe(1)

    for (const policy of [
      { mode: "off", download: "auto" },
      { mode: "lazy", download: "auto" },
      { mode: "auto", download: "manual" },
      { mode: "auto", download: "never" },
    ] satisfies Array<Policy>) {
      await Effect.runPromise(run(policy, start))
    }
    expect(started).toBe(1)
  })

  test("run swallows start failures so boot can never be brought down", async () => {
    await Effect.runPromise(
      run({ mode: "auto", download: "auto" }, Effect.fail(new Error("simulated download failure")), {
        maxAttempts: 1,
        sleep: () => Effect.void,
      }),
    )
  })

  test("backs off warm-up retries with jitter and a bounded delay", () => {
    expect(retryDelay(0, 0)).toBe(5_000)
    expect(retryDelay(1, 0)).toBe(10_000)
    expect(retryDelay(99, 1)).toBe(300_000)
    expect(retryDelay(0, 1)).toBe(6_000)
  })

  test("retries after failures and resets the attempt after a manual reset", async () => {
    let attempts = 0
    const delays: number[] = []
    const start = Effect.sync(() => {
      attempts += 1
      if (attempts < 3) {
        if (attempts === 2) reset()
        throw new Error("same warm-up failure")
      }
    })

    await Effect.runPromise(
      run({ mode: "auto", download: "auto" }, start, {
        random: () => 0,
        sleep: (milliseconds) => Effect.sync(() => delays.push(milliseconds)),
      }),
    )

    expect(delays).toEqual([5_000, 5_000])
  })

  test("deduplicates similar failure messages", () => {
    expect(failureMessageKey("Download failed for model 1234567890")).toBe(
      failureMessageKey("download   failed for model 9876543210"),
    )
  })
})
