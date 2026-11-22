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
import tempfile
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
# names Windows maps to devices, or to another name, whatever folder they are in
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{n}" for n in range(1, 10)), *(f"LPT{n}" for n in range(1, 10))}


def unsafe_name(name: object) -> bool:
    if not isinstance(name, str) or name in ("", ".", "..") or any(c in name for c in "/\\:\0"):
        return True
    return name[-1] in ". " or name.split(".", 1)[0].rstrip(" ").upper() in WINDOWS_RESERVED


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
        root = out.resolve()
        writes: list[tuple[Path, int, int]] = []

        def walk(node: dict, rel: str) -> None:
            for name, entry in node.get("files", {}).items():
                # names come from the archive: a separator, "..", or a drive or root would put the file outside `out`
                if unsafe_name(name):
                    raise ValueError(f"unsafe file name in the archive: {name!r} under {rel or '.'}")
                path = f"{rel}/{name}" if rel else name
                if any(path.startswith(skip) for skip in SKIP_PACKAGES):
                    continue
                if "files" in entry:
                    walk(entry, path)
                    continue
                if "link" in entry or entry.get("unpacked") or path.endswith(SKIP_SUFFIXES) or "/lib/assets/" in path:
                    continue
                target = out / path
                if not target.resolve().is_relative_to(root):
                    raise ValueError(f"archive entry {path!r} would be written outside {out}")
                offset, size = int(entry["offset"]), int(entry["size"])
                if offset < 0 or size < 0:
                    raise ValueError(f"archive entry {path!r} has a negative offset or size")
                writes.append((target, offset, size))

        # every name is checked before the previous extraction is removed or anything is written
        try:
            walk(manifest, "")
        except ValueError as error:
            print(error)
            return 1
        # the folders leading to `out` are this checkout's own: a link among them would send the files elsewhere
        for folder in (out.parent, out.parent.parent):
            if folder.is_symlink() or (folder.exists() and not folder.is_dir()):
                print(f"{folder} is a link or not a folder; remove it and run again")
                return 1
        out.parent.mkdir(parents=True, exist_ok=True)
        # written into a new private folder first, then swapped in, so nothing else can be writing where the files go
        staging = Path(tempfile.mkdtemp(prefix=".node_modules-", dir=out.parent))
        try:
            for target, offset, size in writes:
                path = staging / target.relative_to(out)
                path.parent.mkdir(parents=True, exist_ok=True)
                handle.seek(base + offset)
                with open(path, "xb") as file:
                    file.write(handle.read(size))
            if out.is_symlink():
                out.unlink()
            elif out.exists():
                shutil.rmtree(out)
            staging.rename(out)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        written = len(writes)
    version = json.loads((out / "@deepseek-ai" / "dsh-session" / "package.json").read_text(encoding="utf-8"))["version"]
    print(f"extracted {written} files of Harness {version} into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
