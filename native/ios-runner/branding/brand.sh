#!/bin/bash
# Brands a built WebDriverAgentRunner-Runner.app as Poki, at build time on macOS (needs Xcode's actool
# and ibtool): the home-screen icon (the bear on brand blue), the display name Poki, and a launch screen
# with the bear on brand blue. The app is unsigned here; it is signed when it is installed.
#   brand.sh <path/to/WebDriverAgentRunner-Runner.app> <path/to/poki-icon.png>
set -euo pipefail
APP="$1"; ICON="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
BLUE="#2084FD"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PLIST="$APP/Info.plist"
[ -f "$PLIST" ] || { echo "no Info.plist in $APP" >&2; exit 1; }

# The asset catalog: a single-size 1024 px app icon on blue, and the bear for the launch screen.
CAT="$WORK/Brand.xcassets"
mkdir -p "$CAT/AppIcon.appiconset" "$CAT/LaunchBear.imageset"
echo '{"info":{"version":1,"author":"poki"}}' > "$CAT/Contents.json"
swift "$HERE/compose.swift" "$ICON" "$CAT/AppIcon.appiconset/icon-1024.png" 1024 0.78 "$BLUE"
cat > "$CAT/AppIcon.appiconset/Contents.json" <<'JSON'
{"images":[{"filename":"icon-1024.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"version":1,"author":"poki"}}
JSON
swift "$HERE/compose.swift" "$ICON" "$CAT/LaunchBear.imageset/bear@3x.png" 600 1.0
cat > "$CAT/LaunchBear.imageset/Contents.json" <<'JSON'
{"images":[{"filename":"bear@3x.png","idiom":"universal","scale":"3x"}],"info":{"version":1,"author":"poki"}}
JSON

MIN="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$PLIST" 2>/dev/null || echo 15.0)"
xcrun actool "$CAT" --compile "$APP" --platform iphoneos --minimum-deployment-target "$MIN" \
  --app-icon AppIcon --output-partial-info-plist "$WORK/partial.plist" \
  --target-device iphone --target-device ipad --output-format human-readable-text --notices --warnings
# The icon keys from actool replace any the runner had.
for key in CFBundleIcons CFBundleIcons~ipad; do /usr/libexec/PlistBuddy -c "Delete :$key" "$PLIST" 2>/dev/null || true; done
/usr/libexec/PlistBuddy -c "Merge $WORK/partial.plist" "$PLIST"

xcrun ibtool --compile "$APP/LaunchScreen.storyboardc" "$HERE/LaunchScreen.storyboard" \
  --minimum-deployment-target "$MIN" --target-device iphone --target-device ipad --errors --warnings

set_key() { /usr/libexec/PlistBuddy -c "Delete :$1" "$PLIST" 2>/dev/null || true; /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
set_key CFBundleDisplayName Poki
set_key UILaunchStoryboardName LaunchScreen
plutil -lint "$PLIST"
echo "branded $APP"
