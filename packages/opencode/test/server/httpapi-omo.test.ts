import { NodeHttpServer } from "@effect/platform-node"
import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { OmoObservability } from "../../src/omo/observability"
import { OmoStatus, type OmoStatusInfo } from "../../src/omo/status"
import { SemifService, type SemifStatus, type Status as SemifStatusInfo } from "../../src/semif/service"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { OmoPaths } from "../../src/server/routes/instance/httpapi/groups/omo"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { omoHandlers } from "../../src/server/routes/instance/httpapi/handlers/omo"
import { semifHandlers } from "../../src/server/routes/instance/httpapi/handlers/semif"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const choices: SemifStatusInfo["choices"] = []

function semifStatus(status: SemifStatus): SemifStatusInfo {
  return {
    status,
    mode: "auto",
    download: "auto",
    backend: "cpu",
    backendRequested: "auto",
    backendFallback: false,
    systemRuntimeMissing: false,
    routing: { requested: "off", effective: "off" },
    choices,
    host: "127.0.0.1",
    port: 8817,
    adopted: false,
  }
}

const ready = semifStatus("ready")

function statusLayer(config: ConfigV1.Info, semif: SemifStatusInfo, failure?: string) {
  const observations: OmoObservability.Interface = {
    record: () => Effect.void,
    last: () => Effect.succeed(undefined),
    lastFailure: () => Effect.succeed(failure ? { reason: failure, durationMs: 1 } : undefined),
    clear: () => Effect.void,
  }
  const semifService = {
    status: () => Effect.die("OMO status must not reconcile SemIf state"),
    statusReadOnly: () => Effect.succeed(semif),
    start: () => Effect.succeed(semif),
    acquire: () => Effect.succeed(semif),
    decide: () => Effect.die("OMO status must not route through SemIf"),
    rememberRouting: () => Effect.void,
    dispose: () => Effect.void,
  } as SemifService.Interface
  return LayerNode.compile(LayerNode.group([OmoStatus.node, Config.node]), [
    [
      Config.node,
      Layer.mock(Config.Service)({
        getGlobal: () => Effect.die("OMO status must not load mutable global config"),
        getGlobalReadOnly: () => Effect.succeed(config),
      }),
    ],
    [SemifService.node, Layer.succeed(SemifService.Service, SemifService.Service.of(semifService))],
    [OmoObservability.node, Layer.succeed(OmoObservability.Service, OmoObservability.Service.of(observations))],
  ])
}

function queryStatus() {
  return OmoStatus.Service.use((service) => service.status())
}

describe("native OMO status", () => {
  it.live("reports disabled OMO and never starts or acquires SemIf", () =>
    Effect.gen(function* () {
      const result = yield* queryStatus().pipe(Effect.provide(statusLayer({ omo: { enabled: false } }, ready)))

      expect(result).toMatchObject({ enabled: false, preset: "auto", agents: [], semif: { status: "ready" } })
      expect(result.conflict).toEqual({ active: false })
    }),
  )

  it.live("reports native agent availability only when registration is active", () =>
    Effect.gen(function* () {
      const result = yield* queryStatus().pipe(Effect.provide(statusLayer({}, ready)))

      expect(result.enabled).toBe(true)
      expect(result.agents).toEqual(["orchestrator", "explore", "librarian", "oracle", "designer", "fixer"])
      expect(result.conflict).toEqual({ active: false })
    }),
  )

  for (const state of ["downloading", "ready", "failed"] as const) {
    it.live(`preserves the read-only SemIf ${state} lifecycle state`, () =>
      Effect.gen(function* () {
        const result = yield* queryStatus().pipe(Effect.provide(statusLayer({}, semifStatus(state))))

        expect(result.semif.status).toBe(state)
      }),
    )
  }

  it.live("reports the exact legacy plugin conflict and suppresses native availability", () =>
    Effect.gen(function* () {
      const result = yield* queryStatus().pipe(
        Effect.provide(statusLayer({ plugin: [ConfigOmo.LEGACY_PLUGIN] }, ready)),
      )

      expect(result.agents).toEqual([])
      expect(result.conflict).toEqual({ active: true, plugin: ConfigOmo.LEGACY_PLUGIN })
    }),
  )

  it.live("exposes only the sanitized and bounded routing failure", () =>
    Effect.gen(function* () {
      const result = yield* queryStatus().pipe(
        Effect.provide(statusLayer({}, ready, `${"routing failure ".repeat(30)} C:\\private\\secret.txt\n`)),
      )

      expect(result.last_failure).toBeDefined()
      expect(result.last_failure!.length).toBeLessThanOrEqual(160)
      expect(result.last_failure).not.toContain("C:\\private\\secret.txt")
      expect(result.last_failure).not.toContain("\n")
    }),
  )
})

const HTTP_STATUS: OmoStatusInfo = {
  enabled: true,
  preset: "openai",
  agents: ["orchestrator", "fixer"],
  semif: ready,
  conflict: { active: false },
  last_failure: "semif is offline",
}

function apiLayer(password: Option.Option<string>) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, semifHandlers, omoHandlers]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(
      Layer.mock(Installation.Service)({
        method: () => Effect.succeed("npm"),
        latest: () => Effect.succeed("9.9.9"),
        upgrade: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(SemifService.Service)({
        status: () => Effect.succeed(ready),
        start: () => Effect.succeed(ready),
        acquire: () => Effect.succeed(ready),
      }),
    ),
    Layer.provide(Layer.mock(OmoStatus.Service)({ status: () => Effect.succeed(HTTP_STATUS) })),
    Layer.provide(ServerAuth.Config.configLayer({ password, username: "opencode" })),
  )
}

const httpIt = testEffect(apiLayer(Option.none()))
const authHttpIt = testEffect(apiLayer(Option.some("secret")))

describe("OMO status HttpApi", () => {
  httpIt.live("GET /omo/status returns the public native status contract", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(OmoPaths.status).pipe(HttpClient.execute)
      const body = (yield* response.json) as unknown

      expect(response.status).toBe(200)
      expect(body).toEqual(HTTP_STATUS)
    }),
  )

  authHttpIt.live("GET /omo/status follows the root authorization contract", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(OmoPaths.status).pipe(HttpClient.execute)
      const authorized = yield* HttpClientRequest.get(OmoPaths.status).pipe(
        HttpClientRequest.setHeader("authorization", ServerAuth.header({ username: "opencode", password: "secret" })!),
        HttpClient.execute,
      )

      expect(response.status).toBe(401)
      expect(authorized.status).toBe(200)
    }),
  )

  it.effect("publishes the omo.status operation in OpenAPI", () => {
    const spec = OpenApi.fromApi(PublicApi) as { paths?: Record<string, Record<string, unknown>> }
    return Effect.sync(() => expect(spec.paths?.[OmoPaths.status]?.get).toBeDefined())
  })
})
