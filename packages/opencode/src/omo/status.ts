import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { agentDefinitions } from "@opencode-ai/core/omo"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { MAX_FAILURE_LENGTH, OmoObservability } from "./observability"
import { SemifService, type Status as SemifStatus } from "@/semif/service"

export type OmoStatusInfo = Readonly<{
  readonly enabled: boolean
  readonly preset: ConfigOmo.Preset
  readonly agents: readonly ConfigOmo.AgentID[]
  readonly semif: SemifStatus
  readonly conflict: Readonly<{
    readonly active: boolean
    readonly plugin?: string
  }>
  readonly last_failure?: string
}>

export interface Interface {
  readonly status: () => Effect.Effect<OmoStatusInfo>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OmoStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const semif = yield* SemifService.Service
    const observability = yield* OmoObservability.Service

    const status = Effect.fn("OmoStatus.status")(function* () {
      const cfg = yield* config.getGlobalReadOnly()
      const resolved = ConfigOmo.resolve(cfg.omo).info
      const pluginConflict = ConfigOmo.hasLegacyPluginConflict(cfg.plugin)
      const lastFailure = yield* observability.lastFailure()
      const semifStatus = yield* semif.statusReadOnly()
      const agents = resolved.enabled && !pluginConflict ? agentDefinitions(resolved).map((agent) => agent.id) : []

      return {
        enabled: resolved.enabled,
        preset: resolved.preset,
        agents,
        semif: semifStatus,
        conflict: {
          active: pluginConflict,
          ...(pluginConflict ? { plugin: ConfigOmo.LEGACY_PLUGIN } : {}),
        },
        ...(lastFailure?.reason ? { last_failure: sanitizeFailure(lastFailure.reason) } : {}),
      } satisfies OmoStatusInfo
    })

    return Service.of({ status })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, SemifService.node, OmoObservability.node],
})

export const layerForTests = layer

function sanitizeFailure(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(?:[a-zA-Z]:[\\/]|\/)[^\s]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FAILURE_LENGTH)
}

export * as OmoStatus from "./status"
