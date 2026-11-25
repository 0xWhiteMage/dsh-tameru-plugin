#!/usr/bin/env python3
"""Package dev/harness and upload it as the release asset CI downloads, keyed to DSH_PIN.

    python scripts/upload_harness_artifact.py

Run scripts/extract_harness.py first (needs an installed DeepSeek Harness at the pinned version — this script refuses
to label an extract of any other version with the checkout's pin). Creates the harness-<pin> release when missing or
replaces the asset in place. Needs gh authenticated with release write access.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "0xWhiteMage/dsh-tameru-plugin"
VERSION_MARKER = Path("node_modules/@deepseek-ai/dsh-agent/package.json")


def run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"{' '.join(args[:2])} failed: {result.stderr.strip()[:300]}")


def extracted_version(harness: Path) -> str | None:
    marker = harness / VERSION_MARKER
    if not marker.is_file():
        return None
    try:
        return json.loads(marker.read_text(encoding="utf-8")).get("version")
    except (json.JSONDecodeError, OSError):
        return None


def main() -> None:
    pin = (ROOT / "DSH_PIN").read_text(encoding="utf-8").strip()
    harness = ROOT / "dev" / "harness"
    if not harness.is_dir():
        sys.exit("dev/harness is missing — run scripts/extract_harness.py first")
    version = extracted_version(harness)
    if version != pin:
        sys.exit(
            f"dev/harness is Harness {version or '(version unreadable)'}, not the pinned {pin} — "
            "extract the pinned install before uploading, or the label would lie to CI"
        )
    tag = f"harness-{pin}"
    asset = f"harness-{pin}.tar.gz"
    # The asset's name in the release is the uploaded file's basename: it must be the exact
    # name the workflow downloads, not a random temporary one.
    blob = Path(tempfile.mkdtemp()) / asset
    run(["tar", "-czf", str(blob), "-C", str(ROOT / "dev"), "harness"])
    exists = subprocess.run(["gh", "release", "view", tag, "--repo", REPO], capture_output=True)
    if exists.returncode != 0:
        run([
            "gh", "release", "create", tag, str(blob), "--repo", REPO,
            "--title", f"Harness extract {pin} (CI fixture)",
            "--notes", "Extracted dev/harness tree for CI. Regenerate with scripts/upload_harness_artifact.py on a DSH_PIN bump.",
        ])
    else:
        # Replace just the asset: the release (and any working fixture) stays up throughout.
        run(["gh", "release", "upload", tag, str(blob), "--repo", REPO, "--clobber"])
    print(f"uploaded {tag}/{asset}")


if __name__ == "__main__":
    main()
