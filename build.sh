#!/usr/bin/env bash
# Local build script — produces a zip ready for "Load unpacked" or Chrome Web Store.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="$SCRIPT_DIR/../video-recorder-v${VERSION}.zip"

rm -f "$OUT"
zip -r "$OUT" . \
  --exclude "*.DS_Store" \
  --exclude "build.sh" \
  --exclude ".gitignore"

echo "✓ Built: $OUT"
echo ""
echo "Install:"
echo "  1. Unzip $OUT"
echo "  2. chrome://extensions → Developer mode → Load unpacked → select the folder"
