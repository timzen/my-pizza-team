#!/usr/bin/env bash
#
# scripts/package-macos-menubar.sh — Build the macOS menu bar app.
#
# Compiles the SwiftUI menu bar app and bundles the mpt binary alongside it.
# No-ops gracefully on non-macOS platforms.
#
# Output: dist/My Pizza Team.app
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

DIST_DIR="$PROJECT_ROOT/dist"
MACOS_APP_DIR="$PROJECT_ROOT/macos-app"
APP_NAME="My Pizza Team"
BINARY="$DIST_DIR/mpt-darwin-arm64"

# Ensure the mpt binary exists
if [ ! -f "$BINARY" ]; then
  echo "❌ mpt binary not found at $BINARY"
  echo "   Run ./scripts/build.sh darwin-arm64 first"
  exit 1
fi

echo "🔨 Building menu bar app..."

# Build the Swift package
cd "$MACOS_APP_DIR"
swift build -c release 2>&1

# Get the built binary
SWIFT_BINARY="$MACOS_APP_DIR/.build/release/MyPizzaTeamMenu"
if [ ! -f "$SWIFT_BINARY" ]; then
  echo "❌ Swift build failed — binary not found"
  exit 1
fi

# Create .app bundle
APP_DIR="$DIST_DIR/${APP_NAME}.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy binaries
cp "$SWIFT_BINARY" "$APP_DIR/Contents/MacOS/MyPizzaTeamMenu"
cp "$BINARY" "$APP_DIR/Contents/MacOS/mpt"
chmod +x "$APP_DIR/Contents/MacOS/MyPizzaTeamMenu"
chmod +x "$APP_DIR/Contents/MacOS/mpt"

# Copy icon
ICON_FILE="$MACOS_APP_DIR/Resources/AppIcon.icns"
if [ ! -f "$ICON_FILE" ]; then
  echo "Generating app icon..."
  swift "$PROJECT_ROOT/scripts/generate-icns.swift"
fi
cp "$ICON_FILE" "$APP_DIR/Contents/Resources/AppIcon.icns"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
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
  <string>0.1.0</string>

  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>

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
echo "   The 🍕 icon will appear in your menu bar."
echo "   Use it to start/stop the daemon, pick a team dir, and open the UI."
