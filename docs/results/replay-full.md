
## DeepSeek-like (read 0.1, write 1.0)

Cost is in input-token equivalents; "change" is Tameru against stock on the same session (negative is cheaper), mean over sessions with a 95% bootstrap interval.

| window | query | arm | n | mean cost | change vs stock | 95% interval | compactions | facts held | shortened/session | ms per step |
|---|---|---|--:|--:|--:|--|--:|--:|--:|--:|
| 128K | specific | stock | 10 | 552,169 |  |  | 1.0 | 1.60 of 5 |  |  |
| 128K | specific | tameru | 10 | 552,169 | +0.0% | +0.0% to +0.0% | 1.0 | 1.60 of 5 | 0.0 | 9 |
| 128K | specific | tameru gate 0.5 | 10 | 556,851 | +0.8% | +0.2% to +1.5% | 1.0 | 1.60 of 5 | 1.9 | 9 |
| 128K | specific | tameru no gate | 10 | 556,851 | +0.8% | +0.2% to +1.5% | 1.0 | 1.60 of 5 | 1.9 | 9 |
| 128K | vague | stock | 10 | 552,084 |  |  | 1.0 | 1.60 of 5 |  |  |
| 128K | vague | tameru | 10 | 552,084 | +0.0% | +0.0% to +0.0% | 1.0 | 1.60 of 5 | 0.0 | 7 |
| 128K | vague | tameru gate 0.5 | 10 | 558,493 | +1.2% | +0.0% to +2.9% | 1.0 | 1.80 of 5 | 1.3 | 7 |
| 128K | vague | tameru no gate | 10 | 558,493 | +1.2% | +0.0% to +2.9% | 1.0 | 1.80 of 5 | 1.3 | 7 |
| 200K | specific | stock | 10 | 774,340 |  |  | 0.0 | 2.60 of 5 |  |  |
| 200K | specific | tameru | 10 | 774,860 | +0.1% | +0.0% to +0.2% | 0.0 | 2.70 of 5 | 0.3 | 19 |
| 200K | specific | tameru gate 0.5 | 10 | 820,081 | +5.9% | +3.7% to +8.3% | 0.0 | 4.50 of 5 | 13.4 | 23 |
| 200K | specific | tameru no gate | 10 | 820,081 | +5.9% | +3.7% to +8.3% | 0.0 | 4.50 of 5 | 13.4 | 23 |
| 200K | vague | stock | 10 | 774,222 |  |  | 0.0 | 2.60 of 5 |  |  |
| 200K | vague | tameru | 10 | 774,222 | +0.0% | +0.0% to +0.0% | 0.0 | 2.60 of 5 | 0.0 | 16 |
| 200K | vague | tameru gate 0.5 | 10 | 806,040 | +4.1% | +2.2% to +6.3% | 0.0 | 3.20 of 5 | 7.3 | 21 |
| 200K | vague | tameru no gate | 10 | 806,040 | +4.1% | +2.2% to +6.3% | 0.0 | 3.20 of 5 | 7.3 | 20 |
| all | all | stock | 40 | 663,204 |  |  | 0.5 | 2.10 of 5 |  |  |
| all | all | tameru | 40 | 663,334 | +0.0% | +0.0% to +0.1% | 0.5 | 2.13 of 5 | 0.1 | 13 |
| all | all | tameru gate 0.5 | 40 | 685,366 | +3.0% | +1.9% to +4.2% | 0.5 | 2.77 of 5 | 6.0 | 15 |
| all | all | tameru no gate | 40 | 685,366 | +3.0% | +1.9% to +4.2% | 0.5 | 2.77 of 5 | 6.0 | 15 |

## write premium (read 0.1, write 1.25)

Cost is in input-token equivalents; "change" is Tameru against stock on the same session (negative is cheaper), mean over sessions with a 95% bootstrap interval.

| window | query | arm | n | mean cost | change vs stock | 95% interval | compactions | facts held | shortened/session | ms per step |
|---|---|---|--:|--:|--:|--|--:|--:|--:|--:|
| 128K | specific | stock | 10 | 629,502 |  |  | 1.0 | 1.60 of 5 |  |  |
| 128K | specific | tameru | 10 | 629,502 | +0.0% | +0.0% to +0.0% | 1.0 | 1.60 of 5 | 0.0 | 9 |
| 128K | specific | tameru gate 0.5 | 10 | 636,189 | +1.1% | +0.3% to +1.9% | 1.0 | 1.60 of 5 | 1.9 | 9 |
| 128K | specific | tameru no gate | 10 | 636,189 | +1.1% | +0.3% to +1.9% | 1.0 | 1.60 of 5 | 1.9 | 9 |
| 128K | vague | stock | 10 | 629,413 |  |  | 1.0 | 1.60 of 5 |  |  |
| 128K | vague | tameru | 10 | 629,413 | +0.0% | +0.0% to +0.0% | 1.0 | 1.60 of 5 | 0.0 | 7 |
| 128K | vague | tameru gate 0.5 | 10 | 637,900 | +1.3% | +0.0% to +3.4% | 1.0 | 1.80 of 5 | 1.3 | 7 |
| 128K | vague | tameru no gate | 10 | 637,900 | +1.3% | +0.0% to +3.4% | 1.0 | 1.80 of 5 | 1.3 | 7 |
| 200K | specific | stock | 10 | 856,952 |  |  | 0.0 | 2.60 of 5 |  |  |
| 200K | specific | tameru | 10 | 857,905 | +0.1% | +0.0% to +0.3% | 0.0 | 2.70 of 5 | 0.3 | 19 |
| 200K | specific | tameru gate 0.5 | 10 | 919,054 | +7.3% | +5.0% to +9.7% | 0.0 | 4.50 of 5 | 13.4 | 23 |
| 200K | specific | tameru no gate | 10 | 919,054 | +7.3% | +5.0% to +9.7% | 0.0 | 4.50 of 5 | 13.4 | 23 |
| 200K | vague | stock | 10 | 856,829 |  |  | 0.0 | 2.60 of 5 |  |  |
| 200K | vague | tameru | 10 | 856,829 | +0.0% | +0.0% to +0.0% | 0.0 | 2.60 of 5 | 0.0 | 16 |
| 200K | vague | tameru gate 0.5 | 10 | 899,910 | +5.0% | +2.9% to +7.5% | 0.0 | 3.20 of 5 | 7.3 | 21 |
| 200K | vague | tameru no gate | 10 | 899,910 | +5.0% | +2.9% to +7.5% | 0.0 | 3.20 of 5 | 7.3 | 20 |
| all | all | stock | 40 | 743,174 |  |  | 0.5 | 2.10 of 5 |  |  |
| all | all | tameru | 40 | 743,412 | +0.0% | +0.0% to +0.1% | 0.5 | 2.13 of 5 | 0.1 | 13 |
| all | all | tameru gate 0.5 | 40 | 773,263 | +3.7% | +2.4% to +5.0% | 0.5 | 2.77 of 5 | 6.0 | 15 |
| all | all | tameru no gate | 40 | 773,263 | +3.7% | +2.4% to +5.0% | 0.5 | 2.77 of 5 | 6.0 | 15 |

Why the pass did nothing at a step (all sessions): {"tameru":{"below_activation":1192,"not_worth_it":175,"no_candidates":801,"not_confident":231},"tameru gate 0.5":{"below_activation":1246,"not_worth_it":681,"no_candidates":424,"not_confident":1},"tameru no gate":{"below_activation":1246,"not_worth_it":683,"no_candidates":423}}
