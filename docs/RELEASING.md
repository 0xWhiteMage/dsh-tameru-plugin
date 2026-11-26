# Releasing dsh-tameru

Nothing here has been done. Publishing is the author's decision; this is the checklist.

1. **Settle the claim first.** Read [REPLAY-VS-STOCK.md](REPLAY-VS-STOCK.md) and [MEASURED-VS-STOCK.md](MEASURED-VS-STOCK.md). The README must not say more than they show: today it says there is no cost saving.
2. **Move the version** in `package.json` and `CHANGELOG.md` (the `[Unreleased]` section becomes the version and a date). The plugin versions independently of the engine.
3. **Pin check.** `DSH_PIN` names the primary stable Harness version the package harness and `scripts/dev_harness.py` were run against; `engines.dsh` must be the exact union of every Harness version admitted after its full suite and in-Harness checks. Re-run both after any change.
4. **Vendored engine.** `python scripts/check_vendored.py --engine <engine checkout>` must report the commit named in `vendor/tameru/__init__.py`. To take a newer engine: copy every file of `src/tameru/` except `__init__.py` from the engine commit (`git show <commit>:src/tameru/<file>`); the engine's `scripts/sync_to_harness.py` copies `*.py` only, so `presets.json` has to be copied by hand, and `check_vendored.py` fails if it is missing or differs. Update `VENDORED_FROM`, re-run everything.
5. **Tests.** `python scripts/extract_harness.py` once, then `npm test` (all pass, none skipped) and `node scripts/compare_stock.ts` / `node scripts/replay.ts` if the engine or the policy changed.
6. **Pack and inspect.** `npm pack` must list `lib/host.js`, `lib/client.js`, `vendor/`, `locale/`, `cordis.patch.yml` and the notices, and no `src/`, `test/`, `dev/` or Python bytecode. A test guards the bytecode.
7. **Try the package as a user would.** `python scripts/dev_harness.py up` installs the packed file into a throwaway Harness; open the bar, pin a line, change a setting, run `/tameru`. Then `python scripts/dev_harness.py clean`.
8. **Publish** to npm (`npm publish`; the name `dsh-tameru` was free when last checked) and tag the commit.
9. **Plugin market (optional).** Fill the placeholders of `docs/PLUGIN-MARKET-ENTRY.json` (the commit, the publish time) and submit it to the market index the Harness is configured with. The index format is the Harness's own (`dsh-plugin-market-index`, format 1).

Things to tell users: it needs the Harness version it was tested on; it needs Python (the Harness's bundled one is used); removing it leaves `<Harness home>/tameru/` (pins and settings), which `/tameru purge` empties; and the Harness itself sends the names of active plugins with requests to the official DeepSeek API.
