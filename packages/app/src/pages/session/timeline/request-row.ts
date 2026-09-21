export const timelinePaddingEnd = 64

export function openRequestKinds(input: { permission: boolean; question: boolean }) {
  return [
    input.permission ? "permission" : undefined,
    input.question ? "question" : undefined,
  ].filter((kind): kind is "permission" | "question" => kind !== undefined)
}

export function requestScrollPadding(height: number) {
  return timelinePaddingEnd + Math.max(0, height)
}

export function openQuestionPart(
  request: { tool?: { messageID: string; callID: string } } | undefined,
  part: { tool: string; messageID: string; callID: string; state: { status: string } },
) {
  const tool = request?.tool
  if (!tool) return false
  if (part.tool !== "question") return false
  if (part.state.status !== "pending" && part.state.status !== "running") return false
  return part.messageID === tool.messageID && part.callID === tool.callID
}

// An empty virtualizer reports paddingEnd - scrollMargin. Subtracting the padding again lands on -scrollMargin, above the content and under the sticky header.
export function requestRowOffset(input: { totalSize: number; requestHeight: number; scrollMargin: number }) {
  const end = input.totalSize - requestScrollPadding(input.requestHeight)
  if (end >= 0) return end
  return end + input.scrollMargin
}
