---
title: Test search
description: "The search box of the Tests tabs: words, qualifiers such as file: and describe:, exclusions and wildcards, and the keys that complete them."
lang: en-US
---

# Test search

A run's **Tests** tab and a project's **Tests** tab share one search box and one language: words that look in every
text of a test, and qualifiers in the style of GitHub search that look in one field, such as `file:cart.spec.ts` or
`describe:"Guest checkout"`. The box lists the qualifiers when it is empty and the values each one can take as you type,
and the list marks what matched. `Ctrl` + `F` (`⌘` + `F` on macOS) jumps to the box; pressed again there, it opens the
browser's own find.

## Words and phrases

A word matches the test title, its describe blocks or its file path, and, on a run's Tests tab, the error text too.
Every word must match, in any of them: `login timeout` finds the tests that mention both. Quotes keep spaces inside one
term: `"guest checkout"`.

## Qualifiers

| Qualifier | Also written | Matches | Tests tab |
|---|---|---|---|
| `file:` | `path:` | The spec file path | Run and project |
| `describe:` | `suite:` | A describe block | Run and project |
| `title:` | `test:`, `name:` | The test title | Run and project |
| `tag:` | | A tag, with or without its `@` | Run and project |
| `browser:` | `project:` | The Playwright project the execution ran in | Run |
| `error:` | | The error text | Run |
| `lock:` | | A [lock](/reference/test-metadata#test-locks) the test declares | Run and project |
| `owner:` | | The `piwi:owner` [annotation](/reference/test-metadata#ownership-metadata-piwi-annotations) | Run and project |
| `priority:` | | The `piwi:priority` annotation | Run and project |
| `feature:` | | The `piwi:feature` annotation | Run and project |
| `id:` | | The test's [external ID](/reference/test-metadata#external-test-ids) | Run and project |

How the terms combine:

- `file:`, `describe:`, `title:` and `error:` match anywhere in the text, and `*` stands for any characters:
  `file:checkout/*.spec.ts`. The other qualifiers match a whole value.
- Case and accents never matter: `resume` finds `Résumé`, and `CAFÉ` finds `cafe`.
- Every term must match. The exception is a qualifier of which a test has only one value (`file:`, `browser:`, `owner:`,
  `priority:`, `feature:`, `id:`): repeated, it matches any of the values, so `file:cart file:checkout` lists both files.
- A leading `-` excludes: `-tag:slow`, `-describe:legacy`, `-flaky`.
- A qualifier the tab does not have, such as `error:` on a project, is read as a word.

## Examples

| Search | Finds |
|---|---|
| `file:cart` | The tests of every file whose path contains `cart` |
| `describe:"Guest checkout" -tag:slow` | The tests inside a *Guest checkout* block that are not tagged `@slow` |
| `timeout browser:webkit` | On a run: the WebKit executions whose title, blocks, path or error mention `timeout` |
| `owner:@team/payments priority:critical` | The critical tests the payments team owns |
| `title:"refund*email"` | The tests whose title has `refund`, then `email` further on |

## Completion

The suggestions follow the term under the caret. An empty term lists the qualifiers; a qualifier lists the values it can
take, with how many tests carry each; a word lists the qualifiers it starts and the values that contain it. On a run the
values come from its executions; on a project, from every test case in the chosen age window.

| Keys | Action |
|---|---|
| `↓` / `↑` | Move through the suggestions |
| `Enter` / `Tab` | Take the highlighted suggestion |
| `Esc` | Close the suggestions |

While you type a qualifier's value, the closest match is highlighted, so `Enter` completes it. A plain word is never
replaced by a qualifier unless you move to one first.

## Order

Both tabs read in the order of the suite unless you pick another sort. A run's Tests tab opens in **Run order**, when
each test first started (a retried test counts from its first attempt), and in **File order** when grouped by file:
file path, then the line and column the test is declared at, the order `playwright test --list` prints. A project's Tests
tab opens in File order. In the *File + Describe* grouping, a describe block keeps its place in the file among the tests
around it. Outside that grouping, a test's describe blocks are named before its title: `Checkout › pays by card`.

The test catalog's `q` API parameter and the `query` argument of the MCP `get_project_test_catalog` tool take the same
language ([API docs](https://piwitests.dev/demo/docs), [MCP tools](/reference/mcp-tools)).

## Related

- [UI overview](/features/ui-overview): the run and project Tests tabs
- [Test metadata](/reference/test-metadata): the tags, locks and `piwi:` annotations the qualifiers read
- [Keyboard shortcuts](/reference/keyboard-shortcuts): every key the dashboard registers
