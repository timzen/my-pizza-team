/**
 * cli/onboarding-hint.ts — The CLI's pointer to the web UI's Welcome checklist.
 *
 * `mpt setup`, `mpt start --daemon` and `mpt lead` are the commands a new user runs
 * first, and the next step after them is in the web UI, not the terminal. So each
 * ends by asking the daemon's `GET /api/onboarding` whether the team is still being
 * onboarded (the Welcome card is showing) and, if so, prints one line sending the
 * user to it. An onboarded team keeps the command's usual output, and an unreachable
 * daemon (setup usually runs before one exists) adds nothing — the pointer is a
 * courtesy, never a warning. See docs/DESIGN.md "First run: a checklist, not a tour".
 * `mpt doctor` deliberately doesn't print it: doctor is a read-only checklist of
 * prerequisites, not a tour guide.
 */

import type { OnboardingResponse } from "../shared/protocol.ts";

/** The part of `GET /api/onboarding` the pointer needs. */
export type OnboardingHintInput = Pick<OnboardingResponse, "visible">;

/**
 * The line to print after a first-run command, or null for none. Pure.
 *
 * "Not onboarded yet" is the daemon's own `visible`: the card shows (no dismissal,
 * not completed, no history — or reopened from Help), so the terminal and the UI
 * never disagree about whether there's a checklist to go to. `null` input (the
 * daemon wasn't reachable, or answered with an error) means silence.
 */
export function onboardingHintLine(onboarding: OnboardingHintInput | null, port: number): string | null {
  if (!onboarding?.visible) return null;
  return `Open http://localhost:${port}/ — the Welcome checklist walks you through your first task`;
}

/**
 * Ask the daemon for onboarding progress, or null if it can't say.
 *
 * Short timeout and every failure (refused, timed out, 401 without the token, an
 * older daemon without the route, a malformed body) collapses to null: a command
 * that already succeeded must not fail or stall on its closing hint.
 */
export async function fetchOnboarding(daemonUrl: string, token: string | null): Promise<OnboardingHintInput | null> {
  try {
    const res = await fetch(`${daemonUrl}/api/onboarding`, {
      signal: AbortSignal.timeout(1500),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const body = await res.json() as Partial<OnboardingResponse> | null;
    return typeof body?.visible === "boolean" ? { visible: body.visible } : null;
  } catch {
    return null;
  }
}

/** Fetch and print the pointer line (indented like the commands' own detail lines), if any. */
export async function printOnboardingHint(port: number, token: string | null, indent = ""): Promise<void> {
  const line = onboardingHintLine(await fetchOnboarding(`http://localhost:${port}`, token), port);
  if (line) console.log(`${indent}${line}`);
}
