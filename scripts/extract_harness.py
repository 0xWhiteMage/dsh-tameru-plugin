"""Extract the Harness's own packages from an installed DeepSeek Harness into dev/harness/ so tests can load the real code.

    python scripts/extract_harness.py [--app "<path to the Harness install's resources/app.asar>"]

This is development tooling only. The extracted tree is large, ignored by git, and never shipped. It reads the archive in place
(nothing is written inside the Harness install) and skips what tests never load: the office-suite kit, speech models, image
codecs, the inspector, the document previewer, source maps and type declarations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
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
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CONERR$",
    *(f"{port}{n}" for port in ("COM", "LPT") for n in (*"123456789", "\u00b9", "\u00b2", "\u00b3")),
}


def unsafe_name(name: object) -> bool:
    if not isinstance(name, str) or name in ("", ".", "..") or any(c in name for c in "/\\\0"):
        return True
    if os.name != "nt":
        return False
    # on Windows ':' starts a drive or stream, and device names and trailing dots or spaces name something else
    if ":" in name or name[-1] in ". " or name.split(".", 1)[0].rstrip(" ").upper() in WINDOWS_RESERVED:
        return True
    return bool(getattr(os.path, "isreserved", None) and os.path.isreserved(name))


def no_duplicates(pairs: list[tuple[str, object]]) -> dict:
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ValueError("the archive's file list names a file twice")
    return dict(pairs)


def check_folder(path: Path) -> None:
    """Missing is fine; anything else must be a plain folder, not a link, a junction or other reparse point, or a file."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    except OSError as error:
        raise ValueError(f"cannot check {path}: {error}") from None
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400 or not stat.S_ISDIR(info.st_mode):
        raise ValueError(f"{path} is a link or not a folder; remove it and run again")


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
    try:
        return extract(app, out)
    except ValueError as error:
        print(error)
        return 1


def extract(app: Path, out: Path) -> int:
    size_on_disk = app.stat().st_size
    with app.open("rb") as handle:
        handle.read(4)
        header_size = struct.unpack("<I", handle.read(4))[0]
        handle.read(4)
        json_size = struct.unpack("<I", handle.read(4))[0]
        header = json.loads(handle.read(json_size).decode("utf-8"), object_pairs_hook=no_duplicates)
        base = 8 + header_size
        manifest = header["files"]["dsh"]["files"]["node_modules"]
        # the folders leading to `out` are this checkout's own: a link among them would send the files elsewhere
        for folder in (out.parent.parent, out.parent, out):
            check_folder(folder)
        root = out.resolve()
        writes: list[tuple[Path, int, int, dict]] = []

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
                if offset < 0 or size < 0 or base + offset + size > size_on_disk:
                    raise ValueError(f"archive entry {path!r} points outside the archive")
                writes.append((target, offset, size, entry))

        # every name is checked before the previous extraction is touched or anything is written
        walk(manifest, "")
        out.parent.mkdir(parents=True, exist_ok=True)
        # written into a new private folder, checked, then swapped in; the old extraction is kept until the swap succeeds
        staging = Path(tempfile.mkdtemp(prefix=".node_modules-", dir=out.parent))
        backup = out.parent / f"{staging.name}.old"
        try:
            for target, offset, size, entry in writes:
                path = staging / target.relative_to(out)
                path.parent.mkdir(parents=True, exist_ok=True)
                handle.seek(base + offset)
                data = handle.read(size)
                if len(data) != size:
                    raise ValueError(f"archive entry {target.relative_to(out)} is cut short")
                integrity = entry.get("integrity")
                if isinstance(integrity, dict) and str(integrity.get("algorithm", "")).upper() == "SHA256":
                    if hashlib.sha256(data).hexdigest() != integrity.get("hash"):
                        raise ValueError(f"archive entry {target.relative_to(out)} does not match its hash")
                with open(path, "xb") as file:
                    file.write(data)
                if entry.get("executable"):
                    path.chmod(0o755)
            package = staging / "@deepseek-ai" / "dsh-session" / "package.json"
            try:
                version = json.loads(package.read_text(encoding="utf-8"))["version"]
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise ValueError(f"the archive has no readable dsh-session package.json ({error})") from None
            try:
                if out.exists():
                    out.rename(backup)
                staging.rename(out)
            except BaseException:
                if backup.exists() and not out.exists():
                    backup.rename(out)
                raise
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        shutil.rmtree(backup, ignore_errors=True)
    print(f"extracted {len(writes)} files of Harness {version} into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
