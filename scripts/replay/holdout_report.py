"""Gate 8 quantities for the one holdout look (replay only). Standard library only.

    python scripts/replay/holdout_report.py docs/results/replay-1.10.0-holdout-rows.jsonl

Paired cluster bootstrap by scenario (10,000 resamples, seed 20261119) of T-0 against the 1.9.0-era plugin and against stock:
whole-session cost (pooled over the two windows), facts kept, the extract-fact bar 8(a) and the non-inert share 8(b).
"""
import collections
import json
import random
import sys

rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
W = (128000, 200000)
by = collections.defaultdict(dict)
for r in rows:
    by[r["cluster"]][(r["arm"], r["window"])] = r
clusters = sorted(by)
rng = random.Random(20261119)


def total(cl, arm, key):
    return sum(by[c][(arm, w)][key] for c in cl for w in W)


def pct(cl, a, b, key="cost"):
    return 100 * (total(cl, a, key) / total(cl, b, key) - 1)


def facts(cl, arm):
    return 100 * total(cl, arm, "facts_held") / total(cl, arm, "facts_needed")


def boot(f, n=10000):
    v = sorted(f([rng.choice(clusters) for _ in clusters]) for _ in range(n))
    return v[int(0.025 * n)], v[int(0.975 * n)], v[int(0.95 * n)], v[int(0.05 * n)]  # lo, hi, one-sided upper, one-sided lower


print(f"clusters: {len(clusters)}; arms: {sorted({r['arm'] for r in rows})}")
for ref in ("baseline-1.9.0", "stock"):
    lo, hi, up, _ = boot(lambda cl: pct(cl, "T-0", ref))
    print(f"cost T-0 vs {ref}: {pct(clusters, 'T-0', ref):+.2f}% [{lo:+.2f},{hi:+.2f}] one-sided upper {up:+.2f}; write 1.25: {pct(clusters, 'T-0', ref, 'cost_w125'):+.2f}%")
    lo, hi, _, low = boot(lambda cl: facts(cl, "T-0") - facts(cl, ref))
    print(f"facts kept T-0 minus {ref}: {facts(clusters, 'T-0') - facts(clusters, ref):+.2f} pts [{lo:+.2f},{hi:+.2f}] one-sided lower {low:+.2f}")
for arm in ("stock", "baseline-1.9.0", "T-0"):
    print(f"{arm}: facts kept {facts(clusters, arm):.1f}%")


def ext(cl):
    p = total(cl, "T-0", "extract_facts_possible")
    return 100 * total(cl, "T-0", "extract_facts_kept") / p if p else float("nan")


lo, hi, _, low = boot(ext)
print(f"8(a) accepted extracts keep their facts: {ext(clusters):.1f}% [{lo:.1f},{hi:.1f}] one-sided lower {low:.1f} (bar: at least 90%, lower bound at least 85%)")


def repl(cl):
    t = total(cl, "T-0", "trigger_events")
    return 100 * total(cl, "T-0", "trigger_events_replaced") / t if t else float("nan")


lo, hi, _, low = boot(repl)
print(f"8(b) trigger events where an extract replaced the stock cut: {repl(clusters):.1f}% [{lo:.1f},{hi:.1f}] one-sided lower {low:.1f}")
print(f"second rewrites: {total(clusters, 'T-0', 'second_rewrites')}; shortened per session: {total(clusters, 'T-0', 'shortened') / (2 * len(clusters)):.1f}")
fam = collections.defaultdict(list)
for c in clusters:
    fam[by[c][("T-0", W[0])]["family"]].append(c)
for f, cl in sorted(fam.items()):
    print(f"  {f}: cost vs 1.9.0 {pct(cl, 'T-0', 'baseline-1.9.0'):+.1f}%, facts vs 1.9.0 {facts(cl, 'T-0') - facts(cl, 'baseline-1.9.0'):+.1f} pts")
