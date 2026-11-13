# Third-party notices

This repository is Apache-2.0-licensed (see `LICENSE` and `NOTICE`).

## Tameru engine (vendored)

`vendor/tameru/*.py` (everything except `__init__.py`) is copied byte for byte from
<https://github.com/0xWhiteMage/tameru-compaction-system> at the commit recorded in `vendor/tameru/__init__.py`
(`VENDORED_FROM`). It is by the same author and under the same Apache-2.0 licence. `scripts/check_vendored.py` proves the copy is identical.

## DeepSeek Harness

This plugin is written against the public plugin interfaces of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).
No Harness source is included in this repository. If test fixtures derived from Harness code are ever added, they will be listed here with
the MIT notice the licence requires.
