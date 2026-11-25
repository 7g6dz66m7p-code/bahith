"""Print the SANAD extraction manifest of one local file (evaluation helper).

Usage: uv run --project apps/worker python -I eval/sanad/extract.py <file> <mime-type>
Runs the same `extract_document` the worker uses; no network, storage or database.
"""

import sys
from pathlib import Path

from bahith_worker.sanad.extraction import extract_document


def main() -> None:
    path, mime_type = sys.argv[1], sys.argv[2]
    manifest = extract_document(Path(path).read_bytes(), mime_type)
    sys.stdout.write(manifest.model_dump_json(by_alias=True))


if __name__ == "__main__":
    main()
