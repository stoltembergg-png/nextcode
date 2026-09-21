import type { JSX } from "solid-js"
import type { Todo } from "@opencode-ai/sdk/v2"
import { Show } from "solid-js"
import type { PromptInputV2Strip } from "@opencode-ai/session-ui/v2/prompt-input"
import { SessionRevertList } from "./session-revert-dock"
import { SessionTodoList } from "./session-todo-dock"

export function composerStrip(input: {
  todos: readonly { status: string }[]
  revertCount: number
  expanded: boolean
  onToggle: () => void
  body?: JSX.Element
  todoLabel: (done: number, total: number) => string
  revertLabel: (count: number) => string
}): PromptInputV2Strip | undefined {
  const total = input.todos.length
  const done = input.todos.filter((todo) => todo.status === "completed").length
  if (total === 0 && input.revertCount === 0) return undefined

  const label =
    total > 0 && input.revertCount > 0
      ? `${input.todoLabel(done, total)} · ${input.revertLabel(input.revertCount)}`
      : total > 0
        ? input.todoLabel(done, total)
        : input.revertLabel(input.revertCount)

  return {
    label,
    expanded: input.expanded,
    onToggle: input.onToggle,
    body: input.body,
  }
}

export function ComposerStripBody(props: {
  todos: Todo[]
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
}) {
  return (
    <>
      <Show when={props.todos.length > 0}>
        <SessionTodoList todos={props.todos} />
      </Show>
      <Show when={props.revert?.items.length}>
        <SessionRevertList
          items={props.revert!.items}
          restoring={props.revert!.restoring}
          disabled={props.revert!.disabled}
          onRestore={props.revert!.onRestore}
        />
      </Show>
    </>
  )
}
