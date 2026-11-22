# Third-party notices

This repository and the npm package `dsh-tameru` are Apache-2.0-licensed (see `LICENSE` and `NOTICE`). Copyright 2026 Benjamin Ang.
This file lists everything in them that came from somewhere else, and what is deliberately not included.

## Tameru engine (vendored, shipped)

`vendor/tameru/*.py`, except `__init__.py`, is copied byte for byte from `src/tameru/` of
<https://github.com/0xWhiteMage/tameru-compaction-system> at the commit recorded as `VENDORED_FROM` in `vendor/tameru/__init__.py`
(currently [`9f1f1c4`](https://github.com/0xWhiteMage/tameru-compaction-system/tree/9f1f1c45e432e63119f6fa0cd232bb27b476e05b),
the Tameru 1.9.0 source). `scripts/check_vendored.py` checks that the copy is identical.

The engine has the same author and copyright holder as this plugin. At `9f1f1c4` it was published under the MIT License
([LICENSE at that commit](https://github.com/0xWhiteMage/tameru-compaction-system/blob/9f1f1c45e432e63119f6fa0cd232bb27b476e05b/LICENSE)).
The engine repository was relicensed to Apache-2.0 in
[`ed8bcff`](https://github.com/0xWhiteMage/tameru-compaction-system/commit/ed8bcff), and 1.10.0 is Apache-2.0. The copyright holder
distributes this copy under Apache-2.0 as part of this work. The MIT notice it was published with is kept here:

```text
MIT License

Copyright (c) 2026 Benjamin Ang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

When `VENDORED_FROM` moves to an Apache-2.0 engine commit (1.10.0 or later), this section and `NOTICE` should say so and the MIT
text can go.

`vendor/tameru/__init__.py` and `vendor/run_worker.py` are written for this plugin and are not copied.

## Tameru engine (repository only, not shipped)

`test/fixtures/engine-cases.json` holds the engine's shared task cases, taken from `benchmarks/compare.py` `current_cases()` at
`9f1f1c4` (MIT at that commit, same copyright holder). It is used by the tests and `scripts/compare_stock.ts` and is not in the npm
package.

## DeepSeek Harness

This plugin is written against the public plugin interfaces of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(MIT, Copyright (c) 2026 DeepSeek). No Harness source is included in this repository or in the npm package:

- `react`, `react-dom` and `@deepseek-ai/dsh-client-ui-primitives` are provided by the Harness at run time and are left out of the
  bundle (`external` in `scripts/build.mjs`).
- The Harness icons the bar uses are looked up from the host by name at run time (`src/client/ui.ts`); the fallback drawings and
  `src/shared/ui-icons.json` are this project's own.
- `src/host/stock.ts` restates the stock compaction trigger from its documented formula and defaults; it is not copied code.
- The contract and integration tests load Harness packages that `scripts/extract_harness.py` (or `npm install`) puts in `dev/`,
  which is git-ignored and never committed or shipped.
- The screenshots in `docs/images/` show this plugin running inside the Harness.

If test fixtures derived from Harness code are ever added, they will be listed here with the MIT notice the licence requires.

## Build tool

[esbuild](https://github.com/evanw/esbuild) (MIT) is a development dependency only. With `legalComments: 'none'` no licence text is
dropped, because the bundles contain no third-party code: every bundled input is under `src/`.
