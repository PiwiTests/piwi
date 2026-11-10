---
title: Keyboard shortcuts
description: "Every keyboard shortcut the dashboard registers: the command palette, the assistant, the go-to chords, failure inbox triage, the test lists' search, the keys of the image and element viewers, and Piwi Picker's Runs window."
lang: en-US
---

# Keyboard shortcuts

The dashboard's shortcuts, by where they work. The letter keys never fire while you type in a field.

## Anywhere

| Keys | Action |
|---|---|
| `Ctrl` + `K` (`⌘` + `K` on macOS) | Open the command palette: go to a page, search projects, runs and tests, start a [guide](/features/guides), or ask the [assistant](/features/assistant) |
| `Ctrl` + `I` (`⌘` + `I` on macOS) | Open the [assistant](/features/assistant)'s panel; pressed again, put the cursor in its question field, then close it |
| `g` then `h` | Go to Home |
| `g` then `p` | Go to Projects |
| `g` then `a` | Go to Analytics |
| `g` then `s` | Go to Settings |

## Desktop app

In the [desktop app](/features/desktop)'s dashboard window. On macOS the app menu holds the first four with `⌘`, beside the
docs, and zoom takes `⌘` too; Windows and Linux use `Ctrl`, outside a field you type in.

| Keys | Action |
|---|---|
| `Ctrl` + `,` | Open Settings |
| `Ctrl` + `O` | Pick Playwright archives or bug reports to import |
| `Ctrl` + `[` | Go back |
| `Ctrl` + `]` | Go forward |
| `Ctrl` + `+` / `-` / `0` | Zoom in, out, back to 100% |

## Piwi Picker's Runs window

In [Piwi Picker's Runs window](/features/runs-window), for the stopped test whose row holds the focus, else the only
stopped test shown: a run's worker tabs show one worker at a time. Step and Finish wait for a stop that is no failure.

| Keys | Action |
|---|---|
| `F8` or `F5` | Resume |
| `F10` | Step |
| `Shift` + `F11` | Finish |

While you [watch a stop](/features/runs-window#click-and-type-on-the-view), the view takes your keys, but the
browser's shortcuts, the function keys and `Esc` stay the window's: `Esc` gives the keys back to the window and moves
the focus to **Watch** or **Watch live**. `Tab` moves the focus on past the view, unless you clicked into it: then
`Tab` and `Shift+Tab` go to the page too, until `Esc`. Characters an input method composes (Chinese, Japanese,
Korean) do not reach the page; paste them instead. On a run's worker tabs, the arrow keys, `Home` and `End` move
between the workers.

## Assistant panel

In the [assistant](/features/assistant#asking-a-question)'s question field:

| Keys | Action |
|---|---|
| `Enter` | Ask; `Shift` + `Enter` starts a new line |
| `↑` | On the first line, bring back your previous question, from any of your conversations |
| `↓` | On the last line, go back toward what you were typing |
| `→` | In the empty field, take the question it shows greyed: the one the last answer suggests, or the page's |
| `Esc` | Stop the answer being written |

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
