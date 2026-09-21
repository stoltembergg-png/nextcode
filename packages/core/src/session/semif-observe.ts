export * as SemifObserve from "./semif-observe"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export type CompactChoice = "continue" | "compact"

export interface ObserveCompactInput {
  readonly sessionID: SessionSchema.ID
  readonly actual: CompactChoice
  readonly evidence: string
  readonly tokensBefore: number
  readonly tokensAfterIfCompact: number
}

export interface Interface {
  readonly observeCompact: (input: ObserveCompactInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SemifObserve") {}

export const noop = Layer.succeed(
  Service,
  Service.of({
    observeCompact: () => Effect.void,
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: noop,
  deps: [],
})
