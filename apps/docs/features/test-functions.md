---
title: Test functions catalog
description: "The catalog of the helpers and page-object methods your suite calls, how functions are registered, and how agents and the extension use it."
lang: en-US
---

# Test functions catalog

<Needs reporter />

The test functions catalog is a **per-project registry of your own page-object methods and helpers**, each stored with the DOM pattern its steps produce. It lets recordings and agents refer to *your* code instead of raw locators: the [browser extension](./extension) collapses matched steps in a recording into a call to your function, and an MCP agent can register the functions it writes. The catalog lives in the dashboard: the extension reads from it, and MCP agents add to it.

## Where it lives

A project's **Test functions** page in the dashboard (**Project → Test functions**). Every entry is scoped to that project, and the [browser extension](./extension#connecting-to-a-piwi-instance) caches a mapped project's catalog locally so it can match against it while you record.

<figure>
  <img src="/screenshots/test-functions.png" alt="The test function catalog: page-object methods and helpers, each with its module, the steps it performs and the URL it applies to">
  <figcaption>A project's <strong>Test functions</strong> page: each function with the steps it performs and the pages it applies to.</figcaption>
</figure>

## Registering a function

Four ways in, all producing the same kind of entry. The paste paths stop at a review form; the MCP tool saves directly, and its entries show an `ai-extracted` badge by default.

- **By hand** — **Add function** and fill in the name, kind (page-object method, helper function or fixture), module (its import specifier), parameters and DOM pattern yourself — plus the receiver and class for a page-object method, and an optional URL-pattern glob limiting which pages it applies to.
- **Paste the source, let AI propose it** — paste a page-object method or helper's source and a model proposes the name, parameters, and DOM pattern into a **review form you edit before saving**; the module and URL pattern are never inferred, so you fill those in. With [AI](/features/ai-diagnosis) configured on the instance, an **Extract** button calls it directly.
- **Bring your own AI** — no instance AI, or you'd rather not use it? **Copy prompt for your own AI** copies the full extraction prompt (the rules, the JSON schema, and your pasted code) to paste into any AI chat (ChatGPT, Claude.ai, an IDE assistant). Paste the reply back and it is validated against the exact same schema — no Piwi AI credits spent either way.
- **From a coding agent (MCP)** — an MCP-connected agent (Claude Code, Cursor, …) calls the `create_test_function` [MCP tool](/reference/mcp-tools#create_test_function) directly, reading the source with its own model. No AI call happens on the server side; the tool only validates and persists.

Registered entries are edited in place from the same page — the pencil button reopens the form with everything filled in. Registering, editing, deleting and both paste paths need the **Maintainer** role or above on the project, or an administrator; anyone who can read the project can view the catalog.

## Object parameters

A parameter can be typed **object**, for the options-bag argument most helpers take — `selectOption(page, { label }, { value })`. You list the bag's keys, and a parameter source then targets one key by name, so a generated call passes `{ label: 'Country' }` rather than a bare string.

## What extraction won't do

Extraction is deliberately conservative. A function that branches on its arguments, loops, or calls other helpers whose source isn't visible can't be captured as one fixed pattern — so it comes back with **low confidence and a note** saying what was left out, rather than a confident-looking guess you'd have to catch later.

## Using the catalog

- **While recording**, the extension live-ranks which catalog function the steps so far look like, and on **Copy as TypeScript** matched steps collapse into a call to your function; anything unmatched stays as plain locators. The matcher only ever *selects among* the functions you registered — it never invents one. See the [browser extension](./extension#what-it-does).
- **While recording from your editor**, each run of steps a function performs is written as a call to it as soon as its last step is recorded, a page object taken from the test's fixtures when the file's tests take it there. See [Record tests from the editor](./editor-recording).
- **Against the current page**, the popup's **Test functions** checklist scores every function in the active project's catalog: ready to use here, a partial match, or not found on this page.
- **In the Test Map**, a method or helper on a page the suite reaches that no test runs is a *catalog method, no test calls* [scenario gap](./scenario-gaps): the cheapest test to add, since its steps exist. A step whose target comes from a parameter names no element, so a function whose every target does gets no verdict. See [Gap detectors](/reference/gap-detectors).

## Related

- [Browser extension](./extension) — records against the catalog and consumes it
- [MCP server](./mcp) — the `create_test_function` tool
- [AI diagnosis](/features/ai-diagnosis) — **Extract** uses the research model when one is configured, otherwise the diagnosis model
