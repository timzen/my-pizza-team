#!/usr/bin/env bash
#
# scripts/build.sh — Cross-compile mpt binaries for all supported platforms.
#
# Produces platform-specific binaries in the dist/ directory:
#   - mpt-darwin-arm64  (macOS Apple Silicon)
#   - mpt-darwin-x64    (macOS Intel)
#   - mpt-linux-x64     (Linux x86_64)
#   - mpt-linux-arm64   (Linux ARM64)
#
# Usage:
#   ./scripts/build.sh              # Build all targets
#   ./scripts/build.sh darwin-arm64 # Build a single target
#
# Prerequisites:
#   - Deno v2+
#   - Node.js/npm (for UI build)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"

ALL_TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64"
DENO_PERMISSIONS="--allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-run"
ENTRY_POINT="daemon/main.ts"

# Map friendly name to deno compile --target value
get_deno_target() {
  case "$1" in
    darwin-arm64) echo "aarch64-apple-darwin" ;;
    darwin-x64)   echo "x86_64-apple-darwin" ;;
    linux-x64)    echo "x86_64-unknown-linux-gnu" ;;
    linux-arm64)  echo "aarch64-unknown-linux-gnu" ;;
    windows-x64)  echo "x86_64-pc-windows-msvc" ;;
    *) echo ""; return 1 ;;
  esac
}

# --- Functions ---

build_ui() {
  echo "📦 Building UI..."
  cd "$PROJECT_ROOT/ui"
  npm ci --silent 2>/dev/null || npm install --silent
  npm run build
  cd "$PROJECT_ROOT"
  echo "✅ UI built"
}

compile_target() {
  local name="$1"
  local target
  target=$(get_deno_target "$name")
  if [ -z "$target" ]; then
    echo "❌ Unknown target: $name"
    echo "   Available: $ALL_TARGETS"
    exit 1
  fi
  local output="$DIST_DIR/mpt-${name}"

  echo "🔨 Compiling mpt-${name} (target: ${target})..."
  deno compile \
    $DENO_PERMISSIONS \
    --include ui/dist/ \
    --target "$target" \
    --output "$output" \
    "$ENTRY_POINT"

  echo "✅ Built: $output ($(du -h "$output" | cut -f1))"
}

# --- Main ---

echo "🍕 my-pizza-team cross-compilation build"
echo "   Project: $PROJECT_ROOT"
echo ""

# Create dist directory
mkdir -p "$DIST_DIR"

# Build UI first (shared across all targets)
if [ -d "$PROJECT_ROOT/ui/dist" ]; then
  echo "📦 UI already built (ui/dist/ exists). Skipping. Use 'rm -rf ui/dist' to force rebuild."
else
  build_ui
fi

# Determine which targets to build
if [ $# -gt 0 ]; then
  # Build specific targets
  for target in "$@"; do
    compile_target "$target"
  done
else
  # Build all targets
  for target in $ALL_TARGETS; do
    compile_target "$target"
  done
fi

echo ""
echo "🎉 Build complete! Binaries in: $DIST_DIR/"
ls -lh "$DIST_DIR"/mpt-* 2>/dev/null || true

# Package macOS menu bar app (no-ops on non-macOS)
"$SCRIPT_DIR/package-macos-menubar.sh" || true

# Package Windows tray app zip (no-ops if binary not found)
"$SCRIPT_DIR/package-windows.sh" || true
