#!/usr/bin/env python3
"""Download or regenerate the sample dataset under data/sample/.

Fill in SOURCE_URL and subset rules when the dataset is chosen.
"""

from __future__ import annotations

import json
from pathlib import Path

SAMPLE_DIR = Path(__file__).resolve().parent / "sample"
RECORDS_PATH = SAMPLE_DIR / "records_sample.json"
METADATA_PATH = SAMPLE_DIR / "metadata.csv"

SOURCE_URL = ""  # TBD


def main() -> None:
    if not SOURCE_URL:
        raise SystemExit(
            "SOURCE_URL is not set. Document the source in data/README.md "
            "and update this script before downloading."
        )

    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    # TODO: fetch SOURCE_URL, apply the documented subset, then write:
    #   records_sample.json
    #   metadata.csv
    RECORDS_PATH.write_text(json.dumps([], indent=2) + "\n", encoding="utf-8")
    METADATA_PATH.write_text("id,source,notes\n", encoding="utf-8")
    print(f"Wrote empty placeholders to {SAMPLE_DIR}")


if __name__ == "__main__":
    main()
