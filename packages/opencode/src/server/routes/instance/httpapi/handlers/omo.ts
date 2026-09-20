import { OmoStatus } from "@/omo/status"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"

export const omoHandlers = HttpApiBuilder.group(RootHttpApi, "omo", (handlers) =>
  Effect.gen(function* () {
    const service = yield* OmoStatus.Service
    const status = Effect.fn("OmoHttpApi.status")(function* () {
      return yield* service.status()
    })

    return handlers.handle("status", status)
  }),
)
