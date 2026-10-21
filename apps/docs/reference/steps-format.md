---
title: Steps file format
description: "The steps file: a recording as data, which Piwi Picker saves and piwi codegen turns into a Playwright spec. Every field, the limits and how a file is checked."
lang: en-US
---

# Steps file format

A **steps file** is a recording as data rather than code. [Piwi Picker](/features/extension#record-actions) saves one
with **Download steps**, and [`piwi codegen`](/reference/cli#codegen) turns one into a Playwright spec. Because it
holds steps and not code, the same file can be rendered for different projects (their `test` import, their
`baseURL`) and read again by newer tools.

```json
{
  "v": 1,
  "title": "Coupon not applied",
  "origin": "https://staging.acme.test",
  "recordedAt": 1790467200000,
  "note": null,
  "steps": [
    { "action": "goto", "target": null, "value": "/cart", "redacted": false, "pageUrl": "/cart", "timestamp": 0 },
    {
      "action": "click",
      "target": {
        "tagName": "button",
        "role": "button",
        "accessibleName": "Apply",
        "testId": null,
        "text": "Apply",
        "alternatives": [{ "locator": "getByRole('button', { name: 'Apply' })", "method": "getByRole", "score": 90 }]
      },
      "value": null,
      "redacted": false,
      "pageUrl": "/cart",
      "timestamp": 1
    }
  ]
}
```

## The document

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` or `2` | The format version: `2` when the file uses a `manual` step or the `toContainText`, `toHaveCount` or `toBeChecked` matcher, `1` otherwise. |
| `title` | string or null | The test's title when rendered. |
| `origin` | string or null | The origin the steps were recorded on, such as `https://staging.acme.test`. |
| `recordedAt` | number | When the recording started, in milliseconds since 1970. |
| `note` | string or null | Free text from whoever recorded it. |
| `steps` | list | The steps, in order. |
| `viewports` | list | Optional: the viewport sizes the steps were recorded at; see below. |

URLs on `origin` are stored as paths (`/cart?from=mail`), so a spec rendered from the file can use the project's
`baseURL` instead of the site the steps were recorded on.

## A step

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `goto`, `click`, `dblclick`, `hover`, `fill`, `check`, `uncheck`, `selectOption`, `press`, `setInputFiles`, `dragTo`, `assert` or `manual`. |
| `target` | object or null | The element the step acted on; null for `goto`, a key press on the page, or an `assert` on the URL. |
| `value` | string or null | The URL for `goto`, the typed text for `fill`, the option for `selectOption`, the key for `press`, the chosen files' names for `setInputFiles`, one per line. |
| `redacted` | boolean | The value was typed in a password field and was not kept; the spec reads it from an environment variable named after the field, such as `E2E_PASSWORD`. |
| `pageUrl` | string | The page the step happened on; empty when it is not known, as in steps made from a test run after an action that may have left the page. Replay then waits for no particular page. |
| `timestamp` | number | When it happened. |
| `assertion` | object | On `assert` steps only; see below. |
| `dropTarget` | object | On `dragTo` steps only: the element the target is dropped on, a target like the other. |
| `manual` | object | On `manual` steps only; see [Manual steps](#manual-steps). |

A `hover` step moves the pointer over its target and is written as `await <locator>.hover();`. Piwi Picker records
one before a click on an element that shows only while another is hovered (a row's actions, a menu that opens on
hover); the hover is on the element that shows it.

A `setInputFiles` step keeps the names of the files chosen, never their content. The spec writes
`await <locator>.setInputFiles('invoice.pdf');`, which reads the file from the directory Playwright runs in, and the
converter warns that the file is needed. A `dragTo` step is written as `await <locator>.dragTo(<drop locator>);`.

A target holds what identifies the element: `tagName`, `role`, `accessibleName`, `testId`, `text`, and
`alternatives`, its locators ranked best first. Each alternative has a `locator` (a Playwright locator chain such as
`getByRole('button', { name: 'Apply' })`), the `method` it ends with, and a `score`.

An assertion states what the page should show:

| Field | Type | Meaning |
|---|---|---|
| `matcher` | string | `toHaveText`, `toContainText`, `toHaveValue`, `toHaveAccessibleName`, `toHaveCount`, `toHaveURL`, `toBeVisible`, `toBeHidden`, `toBeEnabled`, `toBeDisabled` or `toBeChecked`. |
| `expected` | string or null | The expected value, required for the first six. A `toHaveURL` value is a path or a URL; a `toHaveCount` value is a whole number, such as `"3"`, written as a number in the spec. |
| `actual` | string or null | What the page showed when it was recorded, kept when it differs; the spec writes it in a comment. |
| `negated` | boolean | Written as `expect(…).not.…`. |
| `note` | string or null | Written as a comment above the assertion. |

`toContainText` finds its value inside the element's text, `toHaveCount` counts every element the target's first
locator finds, and `toBeChecked` checks a checkbox, a radio or an element with `aria-checked`.

## Manual steps

A `manual` step is one nothing can play: a person does it by hand. Piwi writes one when it makes steps from a test run
and the run did not keep enough to play a call, such as a click at a point of the page, a value it kept only in part,
or a check with a regular expression.

```json
{
  "action": "manual",
  "target": null,
  "value": null,
  "redacted": false,
  "pageUrl": "",
  "timestamp": 1790467201000,
  "manual": {
    "description": "Choose in `getByLabel('Invoice')` the file the test chose; the run does not keep its name",
    "location": "tests/billing.spec.ts:31",
    "call": "Set input files getByLabel('Invoice')"
  }
}
```

`description` says what to do and is required; `location` (the test's `file:line`) and `call` (the Playwright call it
stands for) are optional. The spec writes a manual step as a comment, `// Manual step: …`, never as code, and the
converter warns about it. [Replay](/features/replay-a-bug-report#when-a-step-cannot-be-played) hands it to you.

## Viewports

A [bug report](/features/report-a-bug) keeps the size of the page's viewport, in CSS pixels: the size the recording
started at, then each size the window settled at after a resize. Each entry names the step it applies from:

```json
"viewports": [
  { "step": 0, "width": 1280, "height": 720 },
  { "step": 3, "width": 390, "height": 664, "zoom": 1.5 }
]
```

The browser's zoom is already in the size: at 200%, a 1,280-pixel window is 640 CSS pixels wide, and the page lays out
for 640. `zoom` keeps the factor itself when it was not 100%, for whoever reads the report; the spec sets the size as
it is.

The spec sets each one with `await page.setViewportSize({ width, height });`, the first before the first page opens
and the others before the step they apply from. A function call from the project's catalog never stands for steps a
resize falls between. Replay sets the tab's viewport the same way in Chrome and Edge. A file without `viewports` is
played at whatever size the browser or the project has.

## Checks

A file is checked in full before anything uses it, and every problem found is reported with its path
(`steps[2].target.alternatives[0].locator: is not a Playwright locator chain`).

- Each locator must parse as a Playwright locator chain: the `getBy…`, `locator`, `filter`, `nth` family of calls, with
  string, number, regex and object arguments. It is written into the spec from its parsed form, so a file can choose
  locators but can never add code. A regex must be a valid pattern on one line.
- `origin` must be an `http` or `https` origin.
- A redacted step never keeps a value.
- A `hover` or `dblclick` step needs a target and never keeps a value; a `setInputFiles` step needs a target; a
  `dragTo` step needs a target and a `dropTarget`, and never keeps a value; a `manual` step needs a `manual` object
  with a description that is not empty, and never keeps a value.
- A `toHaveCount` assertion's `expected` is a whole number.
- A viewport names a step the file has, after the one before it, with a whole width and height from 1 to 10,000, and
  a `zoom` from 0.25 to 5 when it has one.
- Limits: 200 steps, 50 viewports, 10 alternatives per target, 2,000 characters for values, expected values, URLs and notes, 500 for
  titles, names, texts and locators, and 5 MB for the file.

A recording saved before the format existed (`{ "steps", "startedAt", "startUrl" }`) is read too, and the old
`assertVisible` action is read as an `assert` step with `toBeVisible`. A file is written with the oldest version that
holds its steps, so a reader that only knows version 1 refuses a file using the `manual` action or the
`toContainText`, `toHaveCount` and `toBeChecked` matchers with a message naming the version, and reads every other
file as it did.
