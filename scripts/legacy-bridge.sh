#!/bin/sh
# scripts/legacy-bridge.sh — moves an old compiled-binary mpt (<= 0.27) onto the npm package.
#
# MPT_LEGACY_BRIDGE (marker: cli/doctor.ts recognises this file by it)
#
# Releases up to 0.27 shipped mpt as one compiled binary, and that binary's
# `mpt upgrade` downloads `mpt-<os>-<arch>` from the latest GitHub Release and
# writes it over itself. From 0.28 mpt is the npm package `my-pizza-team`, run by
# Node >=24, and there is no binary to download. So the release workflow
# publishes *this script* under the old asset names (and in checksums.sha256),
# and the old upgrader installs it in the binary's place without knowing the
# difference. See docs/DESIGN.md "Moving Old Binaries Across".
#
# Every time it runs, it:
#   1. finds a Node >=24 (MPT_NODE, the saved ~/.config/mpt/runtime.json, PATH,
#      the usual install locations);
#   2. makes sure the npm package is installed for that Node — the first run
#      installs it with that Node's own npm — records the Node the way
#      `mpt setup` does, and (from a terminal) re-points an old service at Node
#      directly (`mpt adopt-legacy-internal`);
#   3. execs `<node> <global>/my-pizza-team/dist/main.js "$@"`.
#
# So the old upgrader's follow-up calls (`<path> write-extension-internal`, then
# restarting a service that runs `<path> start`) land on the new mpt.
#
# When it can't (no Node >=24, npm can't install, run under sudo, or a case only a
# terminal can finish), it puts the v0.27.0 binary back over itself and runs that,
# after saying why: a machine must never be left with an mpt that doesn't run.

LEGACY_VERSION="0.27.0"
REPO="timzen/my-pizza-team"
PKG="my-pizza-team"
SERVICE_LABEL="com.my-pizza-team.daemon"
MIN_NODE_MAJOR=24

# This script's own path, absolute — the path the old binary lived at.
case "$0" in
  /*) SELF="$0" ;;
  *) SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" ;;
esac

say() { printf 'mpt: %s\n' "$*" >&2; }

# ─── Finding Node ────────────────────────────────────────────────────

runtime_config() {
  if [ "$(uname -s)" = Linux ] && [ -n "${XDG_CONFIG_HOME:-}" ]; then
    case "$XDG_CONFIG_HOME" in /*) printf '%s\n' "$XDG_CONFIG_HOME/mpt/runtime.json"; return ;; esac
  fi
  printf '%s\n' "${HOME:-.}/.config/mpt/runtime.json"
}

# The "node" saved in runtime.json (written by mpt as pretty-printed JSON).
saved_node() {
  cfg="$(runtime_config)"
  [ -f "$cfg" ] || return 0
  sed -n 's/^[[:space:]]*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -n 1
}

# Is $1 a Node >= MIN_NODE_MAJOR?
node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

# The first usable Node, as a path kept as found (never symlink-resolved — a
# stable /opt/homebrew/bin/node survives `brew upgrade`; shared/runtime-config.ts).
# MPT_BRIDGE_NODE_PATHS overrides the fixed locations (tests).
find_node() {
  # shellcheck disable=SC2086 # the fixed locations are a space-separated list
  for c in "${MPT_NODE:-}" "$(saved_node)" "$(command -v node 2>/dev/null)" \
    ${MPT_BRIDGE_NODE_PATHS-/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node}; do
    if node_ok "$c"; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

# ─── That Node's npm and package ─────────────────────────────────────

# Run the npm that belongs to $NODE, with $NODE's directory first on PATH (npm's
# `#!/usr/bin/env node` and its global prefix both follow the Node that runs it —
# the same rule as cli/upgrade.ts resolveNpm).
run_npm() {
  nd="$(dirname "$NODE")"
  if [ -x "$nd/npm" ]; then
    PATH="$nd:$PATH" "$nd/npm" "$@"
  elif [ -f "$nd/../lib/node_modules/npm/bin/npm-cli.js" ]; then
    PATH="$nd:$PATH" "$NODE" "$nd/../lib/node_modules/npm/bin/npm-cli.js" "$@"
  else
    say "no npm found next to $NODE"
    return 127
  fi
}

# The installed package's CLI entry for $NODE, or nothing. The conventional
# layout first (no npm call: this runs on every invocation), then `npm root -g`.
find_entry() {
  lib="$(cd "$(dirname "$NODE")/../lib" 2>/dev/null && pwd)"
  e="$lib/node_modules/$PKG/dist/main.js"
  if [ -n "$lib" ] && [ -f "$e" ]; then printf '%s\n' "$e"; return 0; fi
  root="$(run_npm root -g 2>/dev/null)" || return 1
  e="$root/$PKG/dist/main.js"
  [ -f "$e" ] && printf '%s\n' "$e"
}

# ─── Context ─────────────────────────────────────────────────────────

# Started by the old launchd/systemd service (`<path> start`, no terminal)?
in_service() {
  [ "${1:-}" = start ] && [ ! -t 0 ] || return 1
  [ "${XPC_SERVICE_NAME:-}" = "$SERVICE_LABEL" ] || [ -n "${INVOCATION_ID:-}" ]
}

# ─── Falling back to v0.27.0 ─────────────────────────────────────────

legacy_asset() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) echo "mpt-darwin-arm64" ;;
    Darwin/x86_64) echo "mpt-darwin-x64" ;;
    Linux/x86_64) echo "mpt-linux-x64" ;;
    Linux/aarch64|Linux/arm64) echo "mpt-linux-arm64" ;;
    *) return 1 ;;
  esac
}

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else return 1
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Say why the move can't happen now ($1) and what to do ($2), put the v0.27.0
# binary back in this file's place, and run it with the original arguments.
restore_legacy() {
  why="$1"; todo="$2"; shift 2
  say "can't move to the npm package yet: $why"
  say "$todo"
  asset="$(legacy_asset)" || { say "no v$LEGACY_VERSION binary for $(uname -s)/$(uname -m) to fall back to."; exit 1; }
  # MPT_BRIDGE_LEGACY_BASE overrides where the binary comes from (tests).
  base="${MPT_BRIDGE_LEGACY_BASE:-https://github.com/$REPO/releases/download/v$LEGACY_VERSION}"
  tmp="$(dirname "$SELF")/.mpt-legacy-$$"
  sums="${TMPDIR:-/tmp}/mpt-legacy-sums-$$"
  trap 'rm -f "$tmp" "$sums"' EXIT
  if ! fetch "$base/$asset" "$tmp"; then
    say "couldn't download $base/$asset to put mpt v$LEGACY_VERSION back."
    exit 1
  fi
  if fetch "$base/checksums.sha256" "$sums"; then
    want="$(grep " $asset\$" "$sums" | cut -d' ' -f1)"
    if [ -n "$want" ] && [ "$(sha256 "$tmp")" != "$want" ]; then
      say "checksum mismatch for $asset — not installing it."
      exit 1
    fi
  fi
  chmod 755 "$tmp" && mv -f "$tmp" "$SELF" || { say "couldn't write $SELF."; exit 1; }
  trap - EXIT
  rm -f "$sums"
  say "put mpt v$LEGACY_VERSION back at $SELF; run \`mpt upgrade\` again once that's done."
  exec "$SELF" "$@"
}

# ─── One install at a time ───────────────────────────────────────────

# Teammates call mpt concurrently; only one of them should run `npm install`.
LOCK="${TMPDIR:-/tmp}/mpt-bridge-$(id -u).lock"
lock() {
  i=0
  until mkdir "$LOCK" 2>/dev/null; do
    i=$((i + 1))
    # A crashed holder must not wedge mpt forever.
    if [ "$i" -ge 600 ]; then rm -rf "$LOCK"; i=0; fi
    sleep 1
  done
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
}
unlock() { rmdir "$LOCK" 2>/dev/null; trap - EXIT; }

# ─── Main ────────────────────────────────────────────────────────────

if ! NODE="$(find_node)"; then
  restore_legacy "mpt now runs on Node.js >=$MIN_NODE_MAJOR, and none was found." \
    "Install Node.js $MIN_NODE_MAJOR or newer (https://nodejs.org, or e.g. \`brew install node\`)." "$@"
fi

# Fast path: installed, and the Node is on record.
if ENTRY="$(find_entry)" && [ -n "$ENTRY" ] && [ -n "$(saved_node)" ]; then
  exec "$NODE" "$ENTRY" "$@"
fi

# Under sudo, an install would land in root's npm prefix and root's runtime.json.
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  if [ -n "$ENTRY" ]; then exec "$NODE" "$ENTRY" "$@"; fi
  say "run mpt once as $SUDO_USER (not with sudo) to finish moving to the npm package."
  exit 1
fi

lock
if ! ENTRY="$(find_entry)" || [ -z "$ENTRY" ]; then
  # Does npm put its `mpt` exactly where this file is? Then npm must replace it
  # (--force), and whatever launches this path must be re-pointed at Node first:
  # npm's link is `#!/usr/bin/env node`, which the old service's bare PATH can't run.
  BIN="$(run_npm prefix -g 2>/dev/null)/bin/mpt"
  COLLIDES=""
  [ "$BIN" -ef "$SELF" ] && COLLIDES=1
  if [ -n "$COLLIDES" ] && in_service "$@"; then
    unlock
    restore_legacy "npm installs its mpt at $SELF, which the service runs; that move needs a terminal." \
      "Run \`mpt upgrade\` from a terminal." "$@"
  fi

  say "mpt is now the npm package $PKG, run by Node.js; installing it with $NODE (one time)…"
  out="${TMPDIR:-/tmp}/mpt-bridge-npm-$$.log"
  if [ -n "$COLLIDES" ]; then
    run_npm install -g --force "$PKG" >"$out" 2>&1
  else
    run_npm install -g "$PKG" >"$out" 2>&1
  fi
  status=$?
  cat "$out" >&2
  if [ "$status" -ne 0 ]; then
    if grep -qiE 'EACCES|EPERM|permission denied' "$out"; then
      rm -f "$out"; unlock
      restore_legacy "npm has no permission to write to $(run_npm prefix -g 2>/dev/null)." \
        "Install it once yourself:  sudo env \"PATH=$(dirname "$NODE"):\$PATH\" npm install -g $PKG" "$@"
    fi
    rm -f "$out"; unlock
    restore_legacy "\`npm install -g $PKG\` failed (exit $status)." \
      "Fix the npm error above, or install it yourself:  npm install -g $PKG" "$@"
  fi
  rm -f "$out"
  if ! ENTRY="$(find_entry)" || [ -z "$ENTRY" ]; then
    unlock
    restore_legacy "npm finished, but $PKG/dist/main.js isn't where $NODE's npm says." \
      "Install it yourself:  npm install -g $PKG" "$@"
  fi
fi

# Record the Node the way `mpt setup` does, unless one is (keeping any other keys;
# atomic, like shared/runtime-config.ts). Done here, not left to the package, so the
# fast path above works from the next run whatever version npm installed.
if [ -z "$(saved_node)" ]; then
  "$NODE" -e '
    const fs = require("node:fs"), path = require("node:path");
    const [file, node] = process.argv.slice(1);
    let c = {};
    try { c = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
    if (!c.node) {
      c.node = node; c.chosenAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(c, null, 2) + "\n");
      fs.renameSync(file + ".tmp", file);
    }' "$(runtime_config)" "$NODE" \
    && say "saved $NODE as the Node that runs mpt (change it with  mpt setup --node <path>)."
fi

# From a terminal, move an old service off this path and onto Node directly
# (cli/legacy.ts). Best-effort: the bridge works either way. Its output is shown
# unless the installed mpt predates the command.
if ! in_service "$@"; then
  out="${TMPDIR:-/tmp}/mpt-bridge-adopt-$$.log"
  "$NODE" "$ENTRY" adopt-legacy-internal "$NODE" "$SELF" service >"$out" 2>&1
  grep -q "Unknown command" "$out" || cat "$out" >&2
  rm -f "$out"
fi
unlock

exec "$NODE" "$ENTRY" "$@"
