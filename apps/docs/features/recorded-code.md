---
title: Recorded code
description: "The code a recording from the editor writes, and how to shape it: verified locators, a wait for each new page, the imports it needs, calls to your page objects, passwords read from the environment, and the '@piwi' options in the Playwright config."
lang: en-US
---

# Recorded code

A [recording from the editor](./editor-recording), and a flow [sent from Piwi Picker](./editor-recording#send-from-piwi-picker),
are written as the code your suite would hold: locators verified on the page, calls to your own page objects and
helpers, no password in the file. The Playwright config sets how that code looks for everyone who records in the
repository.

## What a recording writes

- **Locators** come from the same converter as Piwi Picker's recordings and [`piwi codegen`](/reference/cli#codegen):
  each is verified to find the element alone on the page, the stable ones first and those your tests already use
  preferred. A `getByTestId` uses the attribute your config sets.
- **Pages**: an address on the project's `baseURL` is written as a path, and the step that leads to another page is
  followed by a wait for it, except next to a call to your own code, which waits for its pages itself.
- **Imports**: a call to your own code, and `expect` when a step checks something, are imported at the top of the file
  when it lacks them: `expect` from `@playwright/test`, or from your fixtures module when the file or a spec beside it
  imports `expect` from there. A spec that loads `test` with `require` gets `require` lines after its last one.
- **Your own code**: when the editor is connected to an instance or the [desktop app](./desktop), steps that match one
  of your [test functions](./test-functions) become a call to it, as soon as the last of those steps is recorded.
- **Passwords** are never recorded: the code reads them from an environment variable named after the field, such as
  `process.env.E2E_PASSWORD`, including in a call to a page object.

## Code options in the Playwright config

How the recorded code looks is set for the whole repository in `playwright.config.ts`, under the `'@piwi'` key at the
top level, next to `testDir` and `use`. Everyone who records in the repository gets the same code, with or without an
instance:

```ts
import { defineConfig } from '@playwright/test';
import type {} from '@piwitests/reporter'; // declares '@piwi' on the config; already there with wrapConfig

export default defineConfig({
  testDir: './tests',
  '@piwi': {
    codegen: {
      testSteps: 'page',
      tags: ['@recorded'],
      annotations: [{ type: 'piwi:owner', description: '@shop-team' }],
    },
  },
});
```

| Option | Default | What it does |
|---|---|---|
| `pageWaits` | `true` | `false` leaves out the wait for the next page after a step that leads to it |
| `values` | `'literal'` | `'env'` reads every typed value from an environment variable named after its field, not only passwords |
| `envPrefix` | `'E2E_'` | What those variables start with, as in `E2E_PASSWORD`: upper-case letters, digits and underscores |
| `testSteps` | `'none'` | `'page'` wraps the steps of each page in `await test.step('/cart', …)`, so the report reads like the scenario; in a test only, not in a page object or a helper |
| `tags` | none | Tags a new test gets |
| `annotations` | none | Annotations a new test gets, `{ type, description? }` |

The editor reads the section through your project's own Playwright, so it applies to the recordings started after the
config is saved, and to what Piwi Picker sends to the editor. An unknown option or a value of the wrong kind is left
out, and the recording says so when it starts.

## Related

- [Record tests from the editor](./editor-recording): start a recording, and what happens while it runs.
- [Test functions](./test-functions): the page objects and helpers a recording calls.
- [Piwi Picker](./extension): records in your everyday browser, for a bug report or a steps file.
