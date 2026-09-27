// GENERATED FILE — do not edit.
//
// Written by scripts/sync-shared.ts from the repo root's shared/types.ts, which is
// the single definition of these values. Edit them there and run
// `deno task sync-shared`; `deno task test` fails if the two drift
// (docs/DESIGN.md "One Protocol, One Version", P1c-7).
//
// Generated rather than imported because the extension is a self-contained
// package: `mpt setup` writes it to a managed directory outside this repo, so a
// relative import into shared/ would not resolve there.

export const TEAM_DIR: string = ".my-pizza-team";
export const LEGACY_TEAM_DIR: string = ".pi-pizza-team";
export const DEFAULT_DAEMON_URL: string = "http://localhost:7437";
export const DEFAULT_TMUX_SESSION: string = "my-pizza-team";
export const DEFAULT_HARNESS_TEMPLATES: Record<string, { teammate: string; leader?: string }> = {
  "pi": {
    "teammate": "pi -a --ppt-worker --ppt-daemon={url} --ppt-name={name} --ppt-tmux-session={session} --ppt-tmux-window={window}",
    "leader": "pi --ppt-lead --ppt-daemon={url} --ppt-tmux-session={session} --ppt-tmux-window={window}"
  }
};
