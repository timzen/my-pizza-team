/**
 * lib/unread.ts — How many assistant replies you haven't seen, shared by the
 * desktop dock's Assistant tab badge (components/dock/SideDock) and the phone
 * view's Chat tab badge (mobile/MobileShell).
 *
 * Unread = assistant bubbles that arrived since you last looked, where "looking"
 * is the host's call (the dock open on Assistant; the phone on its Chat tab).
 * Derived from one "last looked at" timestamp rather than per-message state, so
 * it needs no server round-trip.
 *
 * Message timestamps come from the daemon while `seenAt` is local; both are
 * usually the same machine, and the worst a skewed clock does is put a badge off
 * by one. Dependency-free so it's unit-tested in tests/mobile.test.ts.
 */

export function countUnread(
  messages: Array<{ role: string; createdAt: string }>,
  seenAt: number,
  looking: boolean,
): number {
  if (looking) return 0;
  return messages.filter((m) => m.role === "assistant" && new Date(m.createdAt).getTime() > seenAt).length;
}
