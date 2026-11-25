#!/usr/bin/env bash
# Installs the Arabic OCR model BAHITH uses in production (tessdata_best, Apache-2.0),
# pinned to a commit and verified by SHA-256, over the distribution's ara.traineddata.
# Same values as docker/worker.Dockerfile. Usage: sudo scripts/install-arabic-ocr-model.sh
set -euo pipefail
COMMIT=e12c65a915945e4c28e237a9b52bc4a8f39a0cec
SHA256=ab9d157d8e38ca00e7e39c7d5363a5239e053f5b0dbdb3167dde9d8124335896
dir=$(tesseract --list-langs 2>/dev/null | sed -n 's/.*"\(.*\)".*/\1/p' | head -1)
[ -d "$dir" ] || { echo "tesseract tessdata directory not found" >&2; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL -o "$tmp" "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/$COMMIT/ara.traineddata"
echo "$SHA256  $tmp" | sha256sum -c --quiet -
install -m 0644 "$tmp" "${dir%/}/ara.traineddata"
echo "Installed tessdata_best ara ($COMMIT) into $dir"
