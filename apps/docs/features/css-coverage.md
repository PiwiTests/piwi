---
title: CSS coverage
description: "The style sheet rules each Playwright test's pages matched, recorded from Chromium's CSS rule usage, so a change to a rule selects the tests that rendered it instead of the whole suite."
lang: en-US
---

# CSS coverage

Each test records the rules of your style sheets its pages matched: a rule counts once an element on the page matched
its selector. A change to a style sheet then selects the tests that rendered the rules it touched, where a style
change used to run the whole suite. It sits beside [code reach](./code-reach), the scripts' side, and
[server coverage](./server-coverage).

## Turn it on

Set `coverage.css: 'rules'` in the reporter options, or `PIWI_COVERAGE_CSS=rules`, with the
[capture fixtures](/guide/capture-fixtures) in place. It is a choice of its own, independent of `coverage.browser`.

```ts
reporter: [['@piwitests/reporter', { coverage: { browser: 'functions', css: 'rules' } }]],
```

## What it records

The fixtures start Chromium's CSS rule usage on each page the test has, in the same capture as code reach, and read
it as each document is left and when the test ends. Each style sheet goes to its file:

- a sheet with a source map (Sass, Less, PostCSS, a `.vue` file's `<style>` with Vite's `css.devSourcemap`) counts in
  the map's sources;
- a `<style>` element a Vite dev server injected counts in the file its `data-vite-dev-id` names, at its lines there,
  a component's `<style>` block included;
- a sheet served as written (`/assets/app.css`) is the file at that path, found as
  [code reach](./code-reach#what-it-records) finds a module.

A style rule counts from its selector to its closing brace, like a function. A grouping rule (`@media`, `@supports`,
`@layer`, `@container`) counts its first line once a rule inside it matched. Every rule of each sheet, matched or not,
goes with the run, for the file's ratio.

## Where it is used

Wherever browser files are read: the execution page's coverage, a file's coverage page, the tests behind a line,
[test selection](./change-impact) (a changed rule selects the tests that matched it; a change outside every rule, at
file level, the tests that matched any), and [uncovered changes](./uncovered-changes).

On the sample application, a change to its stylesheet selected 23 of its 32 tests by file, and 12 by line for a change
to one rule, where it ran all 32 before.

## Cost

The cost is Chromium's style recalculation, not the reads: about 10% more per test on the sample application, close to
what function coverage costs there, and up to 57% on a page with 2,000 rules and frequent re-renders, where function
coverage costs 4%. Turn it on where style changes are frequent, or in a scheduled run.

## Limits

- **Chromium only**, like JavaScript coverage.
- **A state the tests never reach reads as unused:** a `:hover` never hovered, a breakpoint never rendered, a theme
  never set.
- **Utility CSS** (Tailwind) maps into the framework's own sheet under `node_modules`, which counts for nothing: the
  classes a test used are in the templates code reach already covers.
- **CSS-in-JS and constructed sheets** (`adoptedStyleSheets`) have no file.
- **Production builds:** Vite writes no source map for its CSS and minifies it to one line, so a built sheet maps to no
  source. Record CSS coverage against a dev server, or an application serving its CSS as written.
- A `<style>` in a page's HTML counts only when the page's address names its file (`/index.html`).

## Related

- [Code reach](./code-reach): the scripts each test ran
- [Change impact](./change-impact): the tests a change selects
- [Coverage cost](/reference/coverage-cost): what each mode costs
