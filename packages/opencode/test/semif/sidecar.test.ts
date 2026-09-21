import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner, make } from "effect/unstable/process/ChildProcessSpawner"
import { FetchHttpClient } from "effect/unstable/http"
import { dispose, ensure, sidecarArgs } from "../../src/semif/sidecar"

// Adoption and fallback never spawn, so this layer fails loudly if they try.
const spawner = Layer.succeed(
  ChildProcessSpawner,
  make(() => Effect.die(new Error("semif sidecar test must not spawn"))),
)

const layer = Layer.mergeAll(FetchHttpClient.layer, spawner)

const MODEL_PATH = "/models/LFM2-350M-Q4_K_M.gguf"

function handlerFor(modelPath: string, nGpuLayers?: number) {
  return (req: Request) => {
    const url = new URL(req.url)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.pathname === "/props") {
      return new Response(
        JSON.stringify({
          model_path: modelPath,
          ...(nGpuLayers === undefined ? {} : { n_gpu_layers: nGpuLayers }),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    return new Response("not found", { status: 404 })
  }
}

const config = (port: number) => ({
  host: "127.0.0.1",
  port,
  threads: 1,
  contextSize: 2048,
  loadTimeoutMs: 5_000,
  serverPath: "/nonexistent/llama-server",
  modelPath: MODEL_PATH,
})

test("health is true only for HTTP 200 /health", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return new Response("ok", { status: 200 })
      return new Response("no", { status: 404 })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const { health } = await import("../../src/semif/sidecar")
  const ok = await Effect.runPromise(health(url).pipe(Effect.provide(FetchHttpClient.layer)))
  expect(ok).toBe(true)
  server.stop(true)
})

test("cpu sidecar omits ngl", () => {
  expect(
    sidecarArgs(
      {
        host: "127.0.0.1",
        port: 8817,
        threads: 4,
        contextSize: 2048,
        loadTimeoutMs: 1000,
        serverPath: "/llama-server",
        modelPath: "/model.gguf",
      },
      8817,
    ).includes("-ngl"),
  ).toBe(false)
})

test("gpu sidecar offloads all layers", () => {
  const args = sidecarArgs(
    {
      host: "127.0.0.1",
      port: 8817,
      threads: 4,
      contextSize: 2048,
      loadTimeoutMs: 1000,
      serverPath: "/llama-server",
      modelPath: "/model.gguf",
      nGpuLayers: 99,
    },
    8817,
  )
  const index = args.indexOf("-ngl")
  expect(index).toBeGreaterThanOrEqual(0)
  expect(args[index + 1]).toBe("99")
})

describe("semif sidecar", () => {
  test("adopts a healthy server already serving the configured model", async () => {
    const server = Bun.serve({ port: 0, fetch: handlerFor(MODEL_PATH) })
    const port = server.port ?? 0
    try {
      const handle = await Effect.runPromise(Effect.scoped(Effect.provide(ensure(config(port)), layer)))
      expect(handle.adopted).toBe(true)
      expect(handle.port).toBe(port)
      expect(handle.child).toBeUndefined()
      expect(handle.pid).toBeUndefined()

      // dispose must not disturb a server it did not spawn.
      await Effect.runPromise(dispose(handle))
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  test("falls back to the next port when the base port serves another model", async () => {
    let primary: ReturnType<typeof Bun.serve> | undefined
    let fallback: ReturnType<typeof Bun.serve> | undefined
    let base = 0
    for (let candidate = 45100; candidate <= 45190; candidate += 2) {
      try {
        const next = Bun.serve({ port: candidate, fetch: handlerFor("/other/model.gguf") })
        try {
          fallback = Bun.serve({ port: candidate + 1, fetch: handlerFor(MODEL_PATH) })
          primary = next
          base = candidate
          break
        } catch {
          next.stop(true)
        }
      } catch {
        // candidate is busy; try the next pair
      }
    }
    if (!primary || !fallback) throw new Error("could not find a consecutive free port pair")

    try {
      const handle = await Effect.runPromise(
        Effect.scoped(Effect.provide(ensure(config(base)), layer)),
      )
      expect(handle.adopted).toBe(true)
      expect(handle.port).toBe(base + 1)
      expect(handle.child).toBeUndefined()
    } finally {
      primary.stop(true)
      fallback.stop(true)
    }
  })

  test("does not adopt a CPU server when GPU layers are requested", async () => {
    const server = Bun.serve({ port: 0, fetch: handlerFor(MODEL_PATH, 0) })
    const port = server.port ?? 0
    try {
      const handle = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            ensure({
              ...config(port),
              nGpuLayers: 99,
            }),
            layer,
          ),
        ),
      )
      expect(handle.adopted).toBe(false)
    } catch (error) {
      expect(String(error)).toContain("must not spawn")
    } finally {
      server.stop(true)
    }
  })
})
