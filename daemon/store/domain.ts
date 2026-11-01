/**
 * daemon/store/domain.ts — What every Store domain module is built from.
 *
 * The Store is a thin facade over domain classes (daemon/store/members.ts, and in
 * time queue, threads, board, triage, personas — docs/ARCHITECTURE.md "daemon/").
 * Each one gets this context plus a narrow dependency interface of its own for
 * whatever it needs from another domain (the pattern daemon/sources/story.ts's
 * `StorySourceDeps` uses) — never the whole Store.
 */

import type { DatabaseSync } from "node:sqlite";
import type { TeamConfig } from "../../shared/types.ts";

/** The shared state a Store domain module works on. */
export interface StoreDomainContext {
  /** The open `state.db` (schema already migrated). */
  db: DatabaseSync;
  /** The team directory (the files that are the source of truth). */
  teamDir: string;
  /**
   * The team's live config. The same object the Store holds: routes mutate it in
   * place (`PUT /api/config`), so a domain reads it per call, never a copy.
   */
  config: TeamConfig;
}
