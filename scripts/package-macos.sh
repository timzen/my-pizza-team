#!/usr/bin/env bash
#
# scripts/package-macos.sh — Package mpt binary as a macOS .app bundle.
#
# Creates dist/my-pizza-team.app with:
#   - The compiled mpt binary
#   - Info.plist with metadata
#   - A launcher script that starts the daemon and opens the UI in browser
#
# Usage:
#   ./scripts/package-macos.sh                    # Uses dist/mpt-darwin-arm64
#   ./scripts/package-macos.sh dist/mpt-darwin-x64  # Specify binary path
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"

BINARY="${1:-$DIST_DIR/mpt-darwin-arm64}"
APP_NAME="my-pizza-team"
APP_DIR="$DIST_DIR/${APP_NAME}.app"
BUNDLE_ID="com.my-pizza-team.daemon"
VERSION="0.1.0"

if [ ! -f "$BINARY" ]; then
  echo "❌ Binary not found: $BINARY"
  echo "   Run ./scripts/build.sh darwin-arm64 first"
  exit 1
fi

echo "📦 Packaging ${APP_NAME}.app..."

# Clean previous build
rm -rf "$APP_DIR"

# Create .app structure
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy binary
cp "$BINARY" "$APP_DIR/Contents/MacOS/mpt"
chmod +x "$APP_DIR/Contents/MacOS/mpt"

# Create launcher script (starts daemon + opens browser)
cat > "$APP_DIR/Contents/MacOS/launcher" << 'LAUNCHER'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${MPT_PORT:-7437}"

# Start the daemon in background
"$DIR/mpt" &
MPT_PID=$!

# Wait for daemon to be ready
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Open the UI in default browser
open "http://localhost:$PORT"

# Wait for daemon to exit
wait $MPT_PID
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/launcher"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>

  <key>CFBundleDisplayName</key>
  <string>My Pizza Team</string>

  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>

  <key>CFBundleVersion</key>
  <string>${VERSION}</string>

  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>

  <key>CFBundleExecutable</key>
  <string>launcher</string>

  <key>CFBundlePackageType</key>
  <string>APPL</string>

  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>

  <key>LSUIElement</key>
  <true/>

  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# Create a simple icon (optional — uses generic app icon without this)
# To add a custom icon, place an .icns file at Contents/Resources/AppIcon.icns
# and add <key>CFBundleIconFile</key><string>AppIcon</string> to Info.plist

echo ""
echo "✅ Created: $APP_DIR"
echo ""
echo "   To install:"
echo "     cp -r \"$APP_DIR\" /Applications/"
echo ""
echo "   To run:"
echo "     open \"$APP_DIR\""
echo ""
echo "   Note: LSUIElement=true means no Dock icon (runs as background agent)."
echo "   The app starts the daemon and opens http://localhost:7437 in your browser."
echo ""
echo "   To add a custom icon:"
echo "     1. Create an .icns file (use iconutil or an online converter)"
echo "     2. Copy to $APP_DIR/Contents/Resources/AppIcon.icns"
echo "     3. Add CFBundleIconFile key to Info.plist"
