/**
 * tests/mobile.test.ts — The phone view's rules (ui/src/lib/mobile.ts): which
 * shell a path belongs to, when the home page hands a phone to `/m`, the view
 * preference, tab routing, and the Inbox's outcome picking and row retention.
 * Also the two helpers the phone view shares with the desktop: the chat's unread
 * count (ui/src/lib/unread.ts) and a new note's color (ui/src/lib/thoughtColors.ts).
 */

import { assertEquals } from "@std/assert";
import {
  inboxOutcome,
  isMobilePath,
  mergeInboxRows,
  mobileTabOf,
  outcomeBody,
  readViewPref,
  shouldRedirectToMobile,
  VIEW_PREF_KEY,
  writeViewPref,
} from "../ui/src/lib/mobile.ts";
import { countUnread } from "../ui/src/lib/unread.ts";
import { nextRotatedColor } from "../ui/src/lib/thoughtColors.ts";

/** An in-memory Storage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

Deno.test("isMobilePath: /m and below only", () => {
  assertEquals(isMobilePath("/m"), true);
  assertEquals(isMobilePath("/m/"), true);
  assertEquals(isMobilePath("/m/thoughts/abc"), true);
  assertEquals(isMobilePath("/"), false);
  assertEquals(isMobilePath("/metrics"), false);
  assertEquals(isMobilePath("/mobile"), false);
  assertEquals(isMobilePath("/queue"), false);
});

Deno.test("shouldRedirectToMobile: a phone on the home page, unless it asked for desktop", () => {
  assertEquals(shouldRedirectToMobile({ pathname: "/", isPhone: true, pref: null }), true);
  assertEquals(shouldRedirectToMobile({ pathname: "/", isPhone: true, pref: "desktop" }), false);
  assertEquals(shouldRedirectToMobile({ pathname: "/", isPhone: false, pref: null }), false);
});

Deno.test("shouldRedirectToMobile: deep links are never hijacked", () => {
  for (const pathname of ["/queue", "/task/s1/t1", "/work-defs/w1", "/thoughts/n1/triage"]) {
    assertEquals(shouldRedirectToMobile({ pathname, isPhone: true, pref: null }), false, pathname);
  }
});

Deno.test("view preference: round-trips, clears, and tolerates broken storage", () => {
  const s = memoryStorage();
  assertEquals(readViewPref(s), null);
  writeViewPref(s, "desktop");
  assertEquals(s.map.get(VIEW_PREF_KEY), "desktop");
  assertEquals(readViewPref(s), "desktop");
  writeViewPref(s, null);
  assertEquals(readViewPref(s), null);
  assertEquals(s.map.has(VIEW_PREF_KEY), false);

  assertEquals(readViewPref(memoryStorage({ [VIEW_PREF_KEY]: "garbage" })), null);
  assertEquals(readViewPref(undefined), null);
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assertEquals(readViewPref(throwing), null);
  writeViewPref(throwing, "desktop"); // must not throw
});

Deno.test("mobileTabOf: each path's bottom tab; a teammate's view is Team", () => {
  assertEquals(mobileTabOf("/m"), "team");
  assertEquals(mobileTabOf("/m/"), "team");
  assertEquals(mobileTabOf("/m/teammates/t1"), "team");
  assertEquals(mobileTabOf("/m/chat"), "chat");
  assertEquals(mobileTabOf("/m/thoughts"), "thoughts");
  assertEquals(mobileTabOf("/m/thoughts/n1"), "thoughts");
  assertEquals(mobileTabOf("/m/inbox"), "inbox");
  assertEquals(mobileTabOf("/m/chatter"), "team");
});

const c = (from: string, body: string, at: string) => ({ from, body, at });

Deno.test("inboxOutcome: the last closing comment before the state change", () => {
  const comments = [
    c("alice", "[done] Work complete. Summary:\nfirst attempt", "2026-01-01T10:00:00Z"),
    c("you", "please redo X", "2026-01-01T11:00:00Z"),
    c("bob", "working on it", "2026-01-01T12:00:00Z"),
    c("bob", "[done] Work complete. Summary:\nsecond attempt", "2026-01-01T12:30:00Z"),
    c("you", "thanks!", "2026-01-01T15:00:00Z"),
  ];
  // The rework's item finished at 12:30: its summary, not the human's later reply.
  assertEquals(inboxOutcome(comments, { memberId: "bob", lastStateChangeAt: "2026-01-01T12:30:01Z" })?.body.includes("second"), true);
  // The first attempt's item finished at 10:00: the later attempts don't count.
  assertEquals(inboxOutcome(comments, { memberId: "alice", lastStateChangeAt: "2026-01-01T10:00:00Z" })?.body.includes("first"), true);
});

Deno.test("inboxOutcome: a [failed] comment counts", () => {
  const comments = [c("bob", "[failed] blocked on credentials", "2026-01-01T12:00:00Z")];
  assertEquals(inboxOutcome(comments, { memberId: "bob", lastStateChangeAt: "2026-01-01T12:00:00Z" })?.body, "[failed] blocked on credentials");
});

Deno.test("inboxOutcome: no closing tag → the teammate's last comment; nothing → null", () => {
  const comments = [
    c("bob", "analysis: two proposals", "2026-01-01T12:00:00Z"),
    c("you", "hmm", "2026-01-01T12:00:10Z"),
  ];
  assertEquals(inboxOutcome(comments, { memberId: "bob", lastStateChangeAt: "2026-01-01T12:00:20Z" })?.body, "analysis: two proposals");
  assertEquals(inboxOutcome(comments, { memberId: null, lastStateChangeAt: "2026-01-01T12:00:20Z" }), null);
  assertEquals(inboxOutcome([], { memberId: "bob", lastStateChangeAt: "2026-01-01T12:00:20Z" }), null);
});

Deno.test("outcomeBody: drops the machine prefix", () => {
  assertEquals(outcomeBody("[done] Work complete. Summary:\nShipped **it**."), "Shipped **it**.");
  assertEquals(outcomeBody("[failed] blocked on credentials"), "blocked on credentials");
  assertEquals(outcomeBody("plain comment"), "plain comment");
});

Deno.test("mergeInboxRows: retained rows stay, fetched rows win, newest first", () => {
  const row = (id: string, enqueuedAt: string, read = false) => ({ id, enqueuedAt, read });
  const fetched = [row("b", "2026-01-02", false), row("a", "2026-01-01", false)];
  const retained = [row("c", "2026-01-03", true), row("b", "2026-01-02", true)];
  const merged = mergeInboxRows(fetched, retained);
  assertEquals(merged.map((r) => r.id), ["c", "b", "a"]);
  assertEquals(merged.find((r) => r.id === "b")?.read, false); // the fetch is fresher
  assertEquals(mergeInboxRows([], []), []);
});

Deno.test("countUnread: assistant replies after seenAt, none while looking", () => {
  const seen = new Date("2026-01-01T12:00:00Z").getTime();
  const messages = [
    { role: "assistant", createdAt: "2026-01-01T11:59:00Z" },
    { role: "user", createdAt: "2026-01-01T12:01:00Z" },
    { role: "assistant", createdAt: "2026-01-01T12:02:00Z" },
    { role: "assistant", createdAt: "2026-01-01T12:03:00Z" },
  ];
  assertEquals(countUnread(messages, seen, false), 2);
  assertEquals(countUnread(messages, seen, true), 0);
});

Deno.test("nextRotatedColor: one past the newest note's color, cycling", () => {
  assertEquals(nextRotatedColor([]), "yellow");
  assertEquals(nextRotatedColor([
    { color: "blue", createdAt: "2026-01-02" },
    { color: "yellow", createdAt: "2026-01-01" },
  ]), "green");
  assertEquals(nextRotatedColor([{ color: "orange", createdAt: "2026-01-01" }]), "yellow");
  assertEquals(nextRotatedColor([{ color: "not-a-color", createdAt: "2026-01-01" }]), "yellow");
});
