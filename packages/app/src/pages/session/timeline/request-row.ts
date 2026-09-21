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

// An empty virtualizer reports paddingEnd - scrollMargin. Subtracting the padding again lands on -scrollMargin, above the content and under the sticky header.
export function requestRowOffset(input: { totalSize: number; requestHeight: number; scrollMargin: number }) {
  const end = input.totalSize - requestScrollPadding(input.requestHeight)
  if (end >= 0) return end
  return end + input.scrollMargin
}
