/**
 * The assistant identity a cloud response was produced for.
 *
 * Anything that caches or stores a cloud response keys it by this string, so a
 * value fetched for one assistant is never read as the answer for another —
 * the data behind these caches (conversations, assets, avatar urls) is
 * assistant-scoped, so the assistant is the identity that can invalidate it.
 */
export function requestScopeKey(input: {
  assistantId: string | null | undefined;
}): string {
  return `assistant:${input.assistantId ?? "none"}`;
}
