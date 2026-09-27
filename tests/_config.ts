/**
 * tests/_config.ts — the team config tests should use.
 *
 * `DEFAULT_CONFIG` turns autosave on, and autosave runs **real git**: `Store.close()`
 * makes a "shutdown checkpoint" commit. Tests never want that. It was invisible for a
 * long time only because the test task lacked `--allow-run`, so every git call failed
 * on permission and was swallowed. Adding the flag (so the real-tmux tests would stop
 * silently skipping) made every Store-using test shell out to git — slowing the suite
 * from 4s to 12s, and surfacing the autosave data bug fixed in `store/git-sync.ts`.
 *
 * Tests that are *about* autosave call `commitTeamDir` directly against a throwaway
 * repository (tests/git-sync.test.ts). Everything else uses this.
 */

import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";

export const TEST_CONFIG: TeamConfig = {
  ...DEFAULT_CONFIG,
  autosave: { ...DEFAULT_CONFIG.autosave, autoCommit: false },
};
