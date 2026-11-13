"""Extract the Harness's own packages from an installed DeepSeek Harness into dev/harness/ so tests can load the real code.

    python scripts/extract_harness.py [--app "<path to the Harness install's resources/app.asar>"]

This is development tooling only. The extracted tree is large, ignored by git, and never shipped. It reads the archive in place
(nothing is written inside the Harness install) and skips what tests never load: the office-suite kit, speech models, image
codecs, the inspector, the document previewer, source maps and type declarations.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_APP = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "DeepSeek Harness" / "resources" / "app.asar"
SKIP_PACKAGES = (
    "@deepseek-ai/libreoffice-kit",
    "sherpa-onnx",
    "@img/",
    "@deepseek-ai/dsh-experimental-inspector",
    "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
    "@deepseek-ai/dsh-experimental-client-ui-forge",
    "@deepseek-ai/dsh-office-to-pdf",
)
SKIP_SUFFIXES = (".map", ".d.ts", ".png", ".jpg", ".svg", ".woff", ".woff2", ".ttf", ".gif", ".webp", ".ico", ".node")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default=str(DEFAULT_APP))
    args = parser.parse_args()
    app = Path(args.app)
    if not app.is_file():
        print(f"no app.asar at {app}")
        return 1
    out = ROOT / "dev" / "harness" / "node_modules"
    with app.open("rb") as handle:
        handle.read(4)
        header_size = struct.unpack("<I", handle.read(4))[0]
        handle.read(4)
        json_size = struct.unpack("<I", handle.read(4))[0]
        header = json.loads(handle.read(json_size).decode("utf-8"))
        base = 8 + header_size
        manifest = header["files"]["dsh"]["files"]["node_modules"]
        if out.exists():
            shutil.rmtree(out)
        written = 0

        def walk(node: dict, rel: str) -> None:
            nonlocal written
            for name, entry in node.get("files", {}).items():
                path = f"{rel}/{name}" if rel else name
                if any(path.startswith(skip) for skip in SKIP_PACKAGES):
                    continue
                if "files" in entry:
                    walk(entry, path)
                    continue
                if entry.get("unpacked") or path.endswith(SKIP_SUFFIXES) or "/lib/assets/" in path:
                    continue
                target = out / path
                target.parent.mkdir(parents=True, exist_ok=True)
                handle.seek(base + int(entry["offset"]))
                target.write_bytes(handle.read(entry["size"]))
                written += 1

        walk(manifest, "")
    version = json.loads((out / "@deepseek-ai" / "dsh-session" / "package.json").read_text(encoding="utf-8"))["version"]
    print(f"extracted {written} files of Harness {version} into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
