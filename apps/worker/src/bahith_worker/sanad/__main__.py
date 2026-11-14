"""Explicit local manifest export; this command is not a public upload endpoint."""

import argparse
import json
import os
import sys
from pathlib import Path

from bahith_worker.sanad import SanadError, extract_document
from bahith_worker.sanad.extraction import MAX_FILE_BYTES


def main() -> None:
    parser = argparse.ArgumentParser(description="SANAD Retrieve local document extraction")
    parser.add_argument("input", type=Path)
    parser.add_argument("--mime-type", required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        if arguments.input.resolve() == arguments.output.resolve():
            raise SanadError("INVALID_OUTPUT_PATH")
        with arguments.input.open("rb") as source:
            data = source.read(MAX_FILE_BYTES + 1)
        manifest = extract_document(data, arguments.mime_type)
        # Do not overwrite an existing file (including symlinks). The private manifest
        # is created with owner-only permissions, independently of the caller's umask.
        descriptor = os.open(arguments.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(manifest.model_dump_json(by_alias=True, indent=2))
            output.write("\n")
    except SanadError as error:
        sys.stderr.write(json.dumps({"error": error.code}) + "\n")
        raise SystemExit(1) from None
    except OSError:
        sys.stderr.write(json.dumps({"error": "IO_ERROR"}) + "\n")
        raise SystemExit(1) from None
    sys.stdout.write(
        json.dumps(
            {
                "schemaVersion": manifest.schema_version,
                "fileSha256": manifest.file_sha256,
                "unitCount": len(manifest.units),
                "chunkCount": len(manifest.chunks),
                "failureCount": len(manifest.failures),
            }
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
