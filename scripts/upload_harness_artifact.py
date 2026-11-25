#!/usr/bin/env python3
"""Package dev/harness and upload it as the release asset CI downloads, keyed to DSH_PIN.

    python scripts/upload_harness_artifact.py

Run scripts/extract_harness.py first (needs an installed DeepSeek Harness at the pinned version). Creates or replaces the
harness-<pin> release and its asset. Needs gh authenticated with release write access.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"{' '.join(args[:2])} failed: {result.stderr.strip()[:300]}")


def main() -> None:
    pin = (ROOT / "DSH_PIN").read_text(encoding="utf-8").strip()
    harness = ROOT / "dev" / "harness"
    if not harness.is_dir():
        sys.exit("dev/harness is missing — run scripts/extract_harness.py first")
    tag = f"harness-{pin}"
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        blob = tmp.name
    run(["tar", "-czf", blob, "-C", str(ROOT / "dev"), "harness"])
    existing = subprocess.run(
        ["gh", "release", "view", tag, "--repo", "0xWhiteMage/dsh-tameru-plugin"],
        capture_output=True,
    )
    if existing.returncode == 0:
        run(["gh", "release", "delete", tag, "--repo", "0xWhiteMage/dsh-tameru-plugin", "--yes"])
    run([
        "gh", "release", "create", tag, blob, "--repo", "0xWhiteMage/dsh-tameru-plugin",
        "--title", f"Harness extract {pin} (CI fixture)",
        "--notes", "Extracted dev/harness tree for CI. Regenerate with scripts/upload_harness_artifact.py on a DSH_PIN bump.",
    ])
    print(f"uploaded {tag}")


if __name__ == "__main__":
    main()
