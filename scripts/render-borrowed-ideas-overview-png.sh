#!/usr/bin/env bash
# Rasterize docs/invoker-borrowed-ideas-overview-capture.html (three-column layout) to docs/invoker-borrowed-ideas-overview.png
# Requires: Google Chrome or Chromium with headless support; Python 3 with Pillow (PIL) for bottom whitespace trim.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/docs/invoker-borrowed-ideas-overview-capture.html"
OUT="$ROOT/docs/invoker-borrowed-ideas-overview.png"

if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

CHROME="${CHROME:-}"
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then
    CHROME="$c"
    break
  fi
done

if [[ -z "$CHROME" ]]; then
  echo "No Chrome/Chromium found. Set CHROME to the browser binary." >&2
  exit 1
fi

FILE_URL="file://$SRC"
# Viewport: width matches .capture-root + padding; height large enough for full diagram (cropped below).
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1200,3200 \
  --screenshot="$OUT" \
  "$FILE_URL"

python3 <<PY
from PIL import Image
path = "$OUT"
im = Image.open(path).convert("RGB")
w, h = im.size
px = im.load()
threshold = 250
last = 0
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r < threshold or g < threshold or b < threshold:
            last = y
            break
bottom = min(h, last + 40)
im.crop((0, 0, w, bottom)).save(path, optimize=True)
print("cropped height", h, "->", bottom)
PY


echo "wrote $OUT"
