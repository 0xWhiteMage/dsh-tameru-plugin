# Contributing to the DeepSeek Harness plugin

Read the [README](README.md) for the supported host versions and setup. Open a focused pull request against `main`. Keep the engine, host and client boundaries intact. Use the repository's vendoring process when updating the engine.

Use the Node version declared in [package.json](package.json). With the pinned host fixtures available, run `npm ci`, `npm run build` and `npm test`. Report the host revision, engine pin and verification results for compatibility changes. For packaging changes, also inspect the files reported by `npm pack --dry-run` and verify an installation from the resulting package.

Keep private harness artefacts and session material within authorised channels. Follow [SECURITY.md](SECURITY.md) for vulnerability reports.
