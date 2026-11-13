# Tameru against the Harness's stock tool-result pruner: first measurement

**Short answer.** On the same large tool outputs, Tameru keeps the facts a task needs far more often than the stock pruner, and with a specific question it also removes about as much. It removes much less than stock overall, because the plugin only acts when the engine is confident, and stock "saves" more partly by deleting evidence. Tameru is **not** better everywhere: where the evidence sits at the very start of an output and the query is vague, stock's fixed head window does better. This is a per-output measurement, **not** a session cost measurement (see "What this does not show").

## Method

`scripts/compare_stock.ts` (raw rows in `docs/results/`). The engine's 16 shared task cases with a required string (a question, its evidence and distractors, `test/fixtures/engine-cases.json`) are each embedded at the **head, middle or tail** of a routine log of 12,000 or 40,000 characters, giving 192 outputs per query style.

- **Stock**: the Harness's real `ToolResultPruner.pruneContent` (0.2.2-rc.1): above 8,192 characters keep the first 4,096, a marker, and the last 1,024.
- **Tameru**: the real engine through the worker, with the plugin's settings (`minSavingsRatio` 0.25) and its header line counted in the result size.
- **Two query styles.** *question*: the exact question the case asks. *task*: only a generic statement ("Investigate why the build is failing and report the root cause."), i.e. what the plugin has when the user's message does not name the evidence. The plugin builds its query from the tool call and the user's latest message, so real use lies between the two.
- **Measures**: *kept* = every required string is still in the result; *saved* = characters removed (not tokens, not money).
- **Two sets.** The development set used log-line filler. After the results were seen, one rule was fixed (act only when the engine's confidence is at least 0.7) and run once on a **held-out set**: compiler-output filler and different positions/seeds. The threshold 0.7 was read off the development set, so the held-out figures are the fair ones.

## Results

Each cell: required facts kept / characters saved.

| Group (192 outputs per set) | Stock | Tameru, development | Tameru, held-out |
|---|---|---|---|
| All, query = question | 41.7% / 72.6% | 96.9% / 82.8% | 89.6% / 59.7% |
| All, query = task | 41.7% / 72.6% | 67.7% / 47.9% | 56.3% / 24.5% |
| Evidence at head | 81.3% / 72.6% | 73.4% / 72.0% | 73.4% / 44.1% |
| Evidence in the middle | 6.3% / 72.7% | 85.9% / 61.5% | 75.0% / 42.1% |
| Evidence at the tail | 37.5% / 72.6% | 87.5% / 62.6% | 70.3% / 40.2% |
| 12K-character outputs | 43.8% / 58.1% | 89.6% / 53.7% | 75.0% / 36.8% |
| 40K-character outputs | 39.6% / 87.1% | 75.0% / 76.9% | 70.8% / 47.5% |

With the **confidence gate** the plugin ships (act only when the engine reports at least 0.7, otherwise leave the output alone):

| | Stock | Gated, development | Gated, held-out |
|---|---|---|---|
| Question: kept / saved | 41.7% / 72.6% | 100% / 59.2% (acts on 67 of 96) | 96.9% / 43.9% (59 of 96) |
| Task only: kept / saved | 41.7% / 72.6% | 100% / 1.1% (3 of 96) | 89.6% / 6.2% (15 of 96) |
| All: kept / saved | 41.7% / 72.6% | 100% / 30.1% | 93.2% / 25.0% |

Counting every output: facts kept by stock but lost by (ungated) Tameru in 16 of 192 (development) and 20 of 192 (held-out); kept by Tameru but lost by stock in 94 and 80 of 192.

## What this says

1. **Stock's size reduction is not free.** It removes 72.6% of characters on every output but keeps the needed facts in 41.7% of them: in 6% when the evidence is in the middle.
2. **Tameru is query-dependent.** With the exact question it keeps 90 to 97% of facts; with only a generic task it keeps 56 to 68%, and the gate makes it mostly decline (3 to 15 of 96) rather than risk it. In real sessions the plugin's query is the tool call plus the latest user message, so how often it acts depends on how specific that is.
3. **The gate trades savings for safety, and only partly.** On the held-out set it kept 93.2% (not 100%): the engine's confidence is a useful signal, not a guarantee.
4. **Stock wins in one corner:** evidence at the head with a vague query. It was the reason to test `pinRecent` (always keep the first block and newest N blocks) as a fix; that made things worse (62% kept against 82%) and was **not adopted**.
5. The engine's `risk` label did not separate good from bad results (almost every large extract is rated "high"); its `confidence` did, which is why the gate uses it.

## What this does not show

- **Session cost.** Removing characters from one output is not the same as a cheaper session: every change rewrites the provider's prompt cache from that point on, and a lost fact can cost extra turns. The plugin's batch rule (a change must free at least 35% of what it makes the provider rewrite) comes from the Hermes plugin's measurements, not from this benchmark. A whole-session replay against the stock pruner is still to do, and until it is done nothing here supports a claim that Tameru lowers a Harness user's bill.
- **Real outputs.** The filler is routine and machine-generated, which is easy for a query-aware extractor to separate from evidence. Outputs with many near-miss lines would be harder. 14 cases is a small number.
- **Whether a model finds the answer** in the shortened text. "Kept" means the required string is present.
- **Any model or harness other than this one.** These numbers are for Harness 0.2.2-rc.1's stock pruner and the engine at 1.9.0.
