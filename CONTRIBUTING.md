# Contributing

**Issues: open. Pull requests: not right now.**

## Issues — please do

Bug reports and real-world results are genuinely wanted. Most valuable of all:

**Did this work against *your* Dev Hub?** The workaround is verified end to end against exactly one real org. A second data point either strengthens it or exposes an assumption baked into ours. Either outcome is useful — please say so even if it just worked.

Also worth an issue:

- C-1016 behaving differently than described, or not reproducing on your org
- A Salesforce API change that breaks the pin (this is a workaround, not a supported contract — it *will* break eventually)
- Errors the docs don't explain, especially anything not already in [Platform gotchas](README.md#platform-gotchas)

Include your Salesforce API version and whether the Dev Hub is production or a sandbox. **Never paste a consumer key, private key, `04t` id or org id** — redact them.

## Pull requests — not at the moment

This is published as a reference implementation and isn't set up for review or maintenance commitments yet, so a PR will most likely be closed unmerged. That's not a judgement on the change.

**Fork it instead.** Forking is enabled and encouraged — MIT, no attribution required. Your fork is yours; nothing here constrains what you do with it.

If a change would help everyone, open an issue describing it. That's the fastest route to it landing.

## Upstream

The underlying platform problem lives at [forcedotcom/cli#3515](https://github.com/forcedotcom/cli/issues/3515). If your report is really about Salesforce's behaviour rather than this code, that thread is where the affected people — and the maintainers — are.
