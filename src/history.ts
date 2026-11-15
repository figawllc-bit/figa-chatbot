// Bound recent context consistently for AI and deterministic turns. Retry
// deduplication belongs to the persisted message ID, not equality of user text:
// two distinct messages may legitimately have identical wording.
export function appendHistory(history: string[] | undefined, message: string): string[] {
  return [...(history ?? []).slice(-5), message.slice(0, 1000)];
}
