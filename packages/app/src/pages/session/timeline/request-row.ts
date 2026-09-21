export function openRequestKinds(input: { permission: boolean; question: boolean }) {
  return [
    input.permission ? "permission" : undefined,
    input.question ? "question" : undefined,
  ].filter((kind): kind is "permission" | "question" => kind !== undefined)
}
