import { ConfigOmo } from "@opencode-ai/core/config/omo"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { described } from "./metadata"
import { SemifStatusSchema } from "./semif"

const Conflict = Schema.Struct({
  active: Schema.Boolean,
  plugin: Schema.optional(Schema.String),
}).annotate({ identifier: "OmoLegacyPluginConflict" })

export const OmoStatusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  preset: ConfigOmo.Preset,
  agents: Schema.Array(Schema.String),
  semif: SemifStatusSchema,
  conflict: Conflict,
  last_failure: Schema.optional(Schema.String),
}).annotate({ identifier: "OmoStatus" })

export const OmoPaths = {
  status: "/omo/status",
} as const

export const OmoApi = HttpApi.make("omo").add(
  HttpApiGroup.make("omo")
    .add(
      HttpApiEndpoint.get("status", OmoPaths.status, {
        success: described(OmoStatusSchema, "Native OMO status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "omo.status",
          summary: "Get native OMO status",
          description:
            "Get native OMO availability, configured agents, global SemIf state, legacy plugin conflicts, and the latest sanitized routing failure.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "omo", description: "Native OMO status routes." })),
)
