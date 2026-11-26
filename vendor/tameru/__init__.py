"""Vendored Tameru modules (plugin-owned package marker).

The sibling ``*.py`` files and the package data (``presets.json``) are copied byte for byte from ``src/tameru/`` of
https://github.com/0xWhiteMage/tameru-compaction-system by that repository's ``scripts/sync_to_harness.py``.
This ``__init__.py`` belongs to this plugin: upstream's own ``__init__.py`` is package
metadata and is not copied.
"""

from .compress_context import compress_context  # noqa: F401

# Engine commit this directory matches (checked by scripts/check_vendored.py).
VENDORED_FROM = "bd3efa29aa280171cbc2e9499959e623e2d01807"  # Tameru 1.10.0 source (v1.10.0)
