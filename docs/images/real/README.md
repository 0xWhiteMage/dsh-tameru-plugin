# Real interface captures

Captured 2026-11-28 in a throwaway DeepSeek Harness 0.2.2-rc.5 web client, with the current plugin package installed by `scripts/dev_harness.py` and Chrome driving the page locally. The pin commands are real plugin interactions. No real model or tools ran: the stub provider was intentionally unreachable, so these images do not demonstrate output shortening.

- `dsh-tameru-ui.gif` — cropped sequence of typing `/tameru pin ...`, the pin count updating, the pins card and the strength menu.
- `bar-after-pin.png`, `pins-card.png`, `strength-menu.png` — full-size source frames.

`compaction-card.png` and `compaction-viewer.png` are later real captures in the same throwaway Harness. A deterministic localhost OpenAI-compatible mock model emitted `pwsh` tool calls; the Harness executed the tools, and the installed plugin plus vendored engine genuinely shortened six older results. No external model, network service or credentials were used. The capture profile used `activation: 0.3` and `protectRecent: 1` so the demonstration would fit a short session; these are not the shipped defaults.

The older `../bar-*-sample-data.png` files are sample-data illustrations and are no longer needed for the shortened-results card/viewer examples in the README.
