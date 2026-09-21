import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { Effect, Schema } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DelegationService, type TaskPromptOps } from "@/omo/delegation"

export type { TaskPromptOps } from "@/omo/delegation"

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const delegation = yield* DelegationService.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      let currentMetadata: Record<string, unknown> = {}
      const result = yield* delegation.delegate({
        kind: "legacy",
        description: params.description,
        prompt: params.prompt,
        subagent_type: params.subagent_type,
        task_id: params.task_id,
        background: params.background,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        agent: ctx.agent,
        abort: ctx.abort,
        bypassAgentCheck: ctx.extra?.bypassAgentCheck === true,
        ask: ctx.ask,
        metadata: (input) => {
          if (input.metadata && typeof input.metadata === "object") currentMetadata = input.metadata
          return ctx.metadata(input)
        },
        promptOps: ctx.extra?.promptOps as TaskPromptOps | undefined,
      })
      return {
        title: params.description,
        metadata: {
          ...currentMetadata,
          sessionId: result.sessionID,
          ...(result.background ? { background: true } : {}),
          ...(result.jobID ? { jobId: result.jobID } : {}),
        },
        output: result.text,
      }
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
