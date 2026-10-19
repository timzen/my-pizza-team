#!/usr/bin/env bash
#
# scripts/package-macos-menubar.sh — Build the macOS menu bar app.
#
# Compiles the SwiftUI menu bar app (universal: arm64 + x86_64) into an .app bundle.
# The app is only the menu UI: it does not bundle mpt. It runs the npm-installed
# package with the saved Node (~/.config/mpt/runtime.json), so users install mpt with
# `npm i -g my-pizza-team` and `mpt setup` (desktop/macos/Sources/DaemonManager.swift).
# No-ops gracefully on non-macOS platforms.
#
# Output: desktop/macos/dist/My Pizza Team.app — not the root dist/, which is the npm
# package's compiled JS and is wiped by every `npm run build`.
#
# Usage:
#   ./scripts/package-macos-menubar.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Skip on non-macOS
if [ "$(uname -s)" != "Darwin" ]; then
  echo "⚠️  Skipping macOS menu bar app (not running on macOS)"
  exit 0
fi

MACOS_APP_DIR="$PROJECT_ROOT/desktop/macos"
DIST_DIR="$MACOS_APP_DIR/dist"
APP_NAME="My Pizza Team"

echo "🔨 Building menu bar app..."

# Version shown in the app (menu + Get Info), sourced from the root package.json so
# it stays in sync with the npm package rather than drifting.
APP_VERSION="$(grep -m1 '"version"' "$PROJECT_ROOT/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
if [ -z "$APP_VERSION" ]; then APP_VERSION="0.0.0"; fi
echo "   Version: $APP_VERSION"

# Build the Swift package, universal (arm64 + x86_64). The app bundles no JS
# runtime; it launches the npm-installed mpt.
cd "$MACOS_APP_DIR"
swift build -c release --arch arm64 --arch x86_64 2>&1

# Get the built binary (multi-arch builds land under .build/apple/)
SWIFT_BINARY="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/MyPizzaTeamMenu"
if [ ! -f "$SWIFT_BINARY" ]; then
  echo "❌ Swift build failed — binary not found"
  exit 1
fi

# Create .app bundle
APP_DIR="$DIST_DIR/${APP_NAME}.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy the app binary
cp "$SWIFT_BINARY" "$APP_DIR/Contents/MacOS/MyPizzaTeamMenu"
chmod +x "$APP_DIR/Contents/MacOS/MyPizzaTeamMenu"

# Copy icon
ICON_FILE="$MACOS_APP_DIR/Resources/AppIcon.icns"
if [ ! -f "$ICON_FILE" ]; then
  echo "Generating app icon..."
  swift "$PROJECT_ROOT/scripts/generate-icns.swift"
fi
cp "$ICON_FILE" "$APP_DIR/Contents/Resources/AppIcon.icns"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>My Pizza Team</string>

  <key>CFBundleDisplayName</key>
  <string>My Pizza Team</string>

  <key>CFBundleIdentifier</key>
  <string>com.my-pizza-team.menubar</string>

  <key>CFBundleVersion</key>
  <string>${APP_VERSION}</string>

  <key>CFBundleShortVersionString</key>
  <string>${APP_VERSION}</string>

  <key>CFBundleExecutable</key>
  <string>MyPizzaTeamMenu</string>

  <key>CFBundlePackageType</key>
  <string>APPL</string>

  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>

  <key>LSUIElement</key>
  <true/>

  <key>CFBundleIconFile</key>
  <string>AppIcon</string>

  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo ""
echo "✅ Created: $APP_DIR"
echo ""
echo "   To install:"
echo "     cp -r \"$APP_DIR\" /Applications/"
echo ""
echo "   To run:"
echo "     open \"$APP_DIR\""
echo ""
echo "   The 🍕 icon will appear in your menu bar. It runs the npm-installed mpt:"
echo "     npm i -g my-pizza-team && mpt setup"
echo "   Use it to start/stop the daemon, pick a team dir, and open the UI."
