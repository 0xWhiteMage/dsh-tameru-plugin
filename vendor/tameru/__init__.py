"""Vendored Tameru modules (plugin-owned package marker).

The sibling ``*.py`` files are copied byte for byte from ``src/tameru/`` of
https://github.com/0xWhiteMage/tameru-compaction-system by that repository's ``scripts/sync_to_harness.py``.
This ``__init__.py`` belongs to this plugin: upstream's own ``__init__.py`` is package
metadata and is not copied.
"""

from .compress_context import compress_context  # noqa: F401

# Engine commit this directory matches (checked by scripts/check_vendored.py).
VENDORED_FROM = "9f1f1c45e432e63119f6fa0cd232bb27b476e05b"  # Tameru 1.9.0 source
