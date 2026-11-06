#!/bin/bash
# Builds PokiRunnerHost (host/main.m) as a library and makes the runner's XCTRunner executable load it
# before its own code, so the runner opened by hand starts no test (see main.m). macOS with Xcode.
#   install.sh <path/to/WebDriverAgentRunner-Runner.app> iphoneos|iphonesimulator
set -euo pipefail
APP="$1"; SDK="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
MIN="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$APP/Info.plist" 2>/dev/null || echo 15.0)"
TARGET="arm64-apple-ios$MIN"; [ "$SDK" = iphonesimulator ] && TARGET="$TARGET-simulator"
mkdir -p "$APP/Frameworks"
xcrun -sdk "$SDK" clang -dynamiclib -fobjc-arc -target "$TARGET" -framework UIKit -framework Foundation -framework QuartzCore \
  -install_name @rpath/libPokiRunnerHost.dylib "$HERE/main.m" -o "$APP/Frameworks/libPokiRunnerHost.dylib"
# The load command, first among the app's own libraries, with LIEF (a Mach-O editor).
python3 -m venv "${TMPDIR:-/tmp}/poki-lief" && "${TMPDIR:-/tmp}/poki-lief/bin/pip" -q install lief
"${TMPDIR:-/tmp}/poki-lief/bin/python" - "$BIN" <<'PY'
import sys, lief
path = sys.argv[1]
fat = lief.MachO.parse(path)
for binary in fat:
    binary.remove_signature()  # the bundle is signed again when it is installed
    if not any(l.name == "@rpath/libPokiRunnerHost.dylib" for l in binary.libraries):
        binary.add_library("@rpath/libPokiRunnerHost.dylib")
    rpaths = [c.path for c in binary.commands if isinstance(c, lief.MachO.RPathCommand)]
    if "@executable_path/Frameworks" not in rpaths:
        binary.add(lief.MachO.RPathCommand.create("@executable_path/Frameworks"))
fat.write(path)
print("libraries:", [l.name for l in lief.MachO.parse(path).at(0).libraries])
PY
otool -L "$BIN" | grep -q libPokiRunnerHost
echo "PokiRunnerHost installed in $APP"
