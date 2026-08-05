#!/usr/bin/env bash
#
# Renders the Mermaid ER diagram in erd.md to erd.png.
#
# The Markdown source is the canonical version — it renders on GitHub, diffs in review,
# and keeps a binary out of the Git history. This exists only for contexts that need a
# raster image (a slide, a PDF). The output is gitignored.
#
#   ./docs/render-erd.sh

set -euo pipefail

cd "$(dirname "$0")"

SRC="erd.md"
BLOCK="erd.mmd"
OUT="erd.png"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required (mermaid-cli runs in a container)" >&2
  exit 1
}

# Extract the first ```mermaid fenced block from erd.md.
awk '/^```mermaid$/{flag=1; next} /^```$/{if (flag) exit} flag' "$SRC" > "$BLOCK"

if [ ! -s "$BLOCK" ]; then
  echo "no mermaid block found in $SRC" >&2
  rm -f "$BLOCK"
  exit 1
fi

echo "rendering $BLOCK -> $OUT"

docker run --rm -v "$PWD:/data" minlag/mermaid-cli:latest \
  -i "/data/$BLOCK" -o "/data/$OUT" \
  --backgroundColor white --width 1600

rm -f "$BLOCK"

echo "wrote $(pwd)/$OUT"
echo "note: erd.png is gitignored. The Markdown in $SRC stays canonical."
