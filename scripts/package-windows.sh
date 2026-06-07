#!/usr/bin/env bash
#
# scripts/package-windows.sh — Package mpt Windows binary with tray app files.
#
# Creates dist/My-Pizza-Team-windows-x64.zip containing:
#   - mpt.exe (the compiled daemon)
#   - tray.ps1 (system tray app)
#   - My Pizza Team.bat (launcher)
#   - README.md
#
# Usage:
#   ./scripts/package-windows.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
BINARY="$DIST_DIR/mpt-windows-x64.exe"

if [ ! -f "$BINARY" ]; then
  echo "⚠️  Windows binary not found at $BINARY"
  echo "   Run ./scripts/build.sh windows-x64 first (or skip on non-cross-compile hosts)"
  exit 0
fi

echo "📦 Packaging Windows tray app..."

OUT_DIR="$DIST_DIR/My-Pizza-Team-windows"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp "$BINARY" "$OUT_DIR/mpt.exe"
cp "$PROJECT_ROOT/desktop/windows/tray.ps1" "$OUT_DIR/tray.ps1"
cp "$PROJECT_ROOT/desktop/windows/My Pizza Team.bat" "$OUT_DIR/My Pizza Team.bat"
cp "$PROJECT_ROOT/desktop/windows/README.md" "$OUT_DIR/README.md"

# Create zip
cd "$DIST_DIR"
zip -r "My-Pizza-Team-windows-x64.zip" "My-Pizza-Team-windows"
rm -rf "$OUT_DIR"

echo "✅ Created: $DIST_DIR/My-Pizza-Team-windows-x64.zip"
