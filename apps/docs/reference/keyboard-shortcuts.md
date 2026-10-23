---
title: Keyboard shortcuts
description: "Every keyboard shortcut the dashboard registers: the command palette, the go-to chords, failure inbox triage, the test lists' search, and the keys of the image and element viewers."
lang: en-US
---

# Keyboard shortcuts

The dashboard's shortcuts, by where they work. The letter keys never fire while you type in a field.

## Anywhere

| Keys | Action |
|---|---|
| `Ctrl` + `K` (`⌘` + `K` on macOS) | Open the command palette: go to a page, search projects, runs and tests, start a [guide](/features/guides), or ask the [assistant](/features/assistant) |
| `g` then `h` | Go to Home |
| `g` then `p` | Go to Projects |
| `g` then `a` | Go to Analytics |
| `g` then `s` | Go to Settings |

## Failure inbox

On the [failure inbox](/features/failure-clusters#triage-from-the-row-or-the-keyboard), the keys act on the selected
row. The triage actions need the Maintainer role or above on the project.

| Keys | Action |
|---|---|
| `j` / `k` | Select the next / previous row |
| `Shift` + `j` / `k` | Extend the selection down / up |
| `x` | Add the row to the selection, for the bulk bar |
| `Esc` | Clear the selection |
| `o` | Open the cluster |
| `r` | Resolve |
| `i` | Ignore |
| `q` | Quarantine the cluster's tests |
| `a` | Assign |
| `s` | Snooze |
| `l` | Link a known issue |
| `c` | Create an issue in the connected tracker, when the cluster has none |

## Test lists

On a run's and a project's **Tests** tab ([test search](/reference/test-search)):

| Keys | Action |
|---|---|
| `Ctrl` + `F` (`⌘` + `F` on macOS) | Focus the search box; pressed again there, open the browser's find |
| `↓` / `↑` | Move through the search suggestions |
| `Enter` / `Tab` | Take the highlighted suggestion |
| `Esc` | Close the suggestions |

## Screenshot viewer

| Keys | Action |
|---|---|
| `←` / `→` | Previous / next image |
| `Esc` | Zoom out, then close |

## Element picker

When you [pick a replacement locator](/features/locator-healing) on a captured page:

| Keys | Action |
|---|---|
| `↑` | Select the parent of the highlighted element |
| `↓` | Go back down to the child |
| `Esc` | Skip picking, without choosing an element |

## Permission grid

On the [permission grid](/operate/project-access#permission-grid), the arrow keys move between cells, and `Home` / `End`
jump to the first / last column of the row. `Space` or `Enter` opens the focused cell's role menu, and `Esc` closes it.

## Related

- [UI overview](/features/ui-overview): the pages these keys move between
- [Test search](/reference/test-search): the language of the Tests tabs' search box
- [Failure clusters & the inbox](/features/failure-clusters): the triage actions
- [Access, roles and groups](/operate/project-access#permission-grid): the permission grid
