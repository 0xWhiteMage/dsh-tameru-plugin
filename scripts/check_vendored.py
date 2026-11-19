"""Prove that vendor/tameru/ is the engine, byte for byte.

    python scripts/check_vendored.py --engine "D:/Development Projects/Tameru"

Reads the commit from VENDORED_FROM in vendor/tameru/__init__.py and compares every vendor/tameru/ file, Python modules and package data
such as presets.json (except the plugin-owned __init__.py), with `git show <commit>:src/tameru/<file>` in the engine checkout. Exits 1 on any difference, a missing file, or a stale file.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "tameru"


def git(engine: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(engine), *args], check=True, capture_output=True).stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", required=True, help="path to a tameru-compaction-system checkout")
    engine = Path(parser.parse_args().engine)
    match = re.search(r'VENDORED_FROM\s*=\s*"([0-9a-f]{40})"', (VENDOR / "__init__.py").read_text(encoding="utf-8"))
    if not match:
        print("VENDORED_FROM is missing or not a 40-character commit")
        return 1
    commit = match.group(1)
    upstream = {
        line.rsplit("/", 1)[-1]
        for line in git(engine, "ls-tree", "-r", "--name-only", commit, "src/tameru").decode().splitlines()
        if line.count("/") == 2 and not line.endswith("/__init__.py") and not line.endswith(".pyc")
    }
    ours = {p.name for p in VENDOR.iterdir() if p.is_file() and p.name != "__init__.py" and p.suffix != ".pyc"}
    problems = [f"missing: {n}" for n in sorted(upstream - ours)] + [f"stale: {n}" for n in sorted(ours - upstream)]
    for name in sorted(upstream & ours):
        if git(engine, "show", f"{commit}:src/tameru/{name}") != (VENDOR / name).read_bytes():
            problems.append(f"differs: {name}")
    for problem in problems:
        print(problem)
    print(f"vendor/tameru matches engine commit {commit[:7]}" if not problems else f"{len(problems)} problem(s) against {commit[:7]}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
