---
title: The piwi-turbo command
description: "Run Playwright through piwi-turbo to cut the start of each run: cached modules, a spare worker and browser, and a warm runner between commands."
lang: en-US
---

# The piwi-turbo command

`piwi-turbo`, part of [`@piwitests/turbo`](./turbo), runs your project's Playwright with the start of each run cut
down. Playwright loads its own modules before it reads the config, and each worker loads them again. The command passes
every Playwright command and option on:

```sh
npx piwi-turbo test tests/checkout.spec.ts
```

It caches Playwright's compiled modules for the runner and its workers, and for `test` starts a spare worker that
loads Playwright, and launches the browser the last run launched, while the runner reads the config. A single test went
from 1.2 s to 0.7 s: it helps an edit-and-run loop or an agent that runs one test at a time, not a long CI run. IDE
extensions that start `playwright` themselves bypass it.

With `--warm` first, a background process keeps a runner loaded for the next `test` command: a test that opens a page
took 0.4 s, without the start of `npx`. The [package
README](https://github.com/PiwiTests/piwi/tree/main/packages/turbo#a-faster-start-piwi-turbo) lists its variables and
measurements.

## Related
- [Faster test runs](./turbo) — the presets and levers `@piwitests/turbo` applies to the config
- [Our suite takes too long: where is the time going?](/recipes/faster-suite) — find the time before cutting it
