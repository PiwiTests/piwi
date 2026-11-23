---
title: The demo video is also a test
description: "How Piwi's showcase video is made: a script plays one story on the real tools, checks every step, and renders the cut from the recording, with no hand editing."
date: 2026-11-23
author: Fabien Ménager
excerpt: 'Piwi films its own demo. A script plays one story on the dashboard, VS Code, the browser extension and a real Playwright run, asserts what each step left, and renders the video from the recording. Every night it runs as the only test of all the tools together.'
sidebar: false
---

# The demo video is also a test

Piwi is several tools that have to work together: the reporter in your Playwright run, the dashboard that keeps the
results, the editor extension with its language server, and Piwi Picker in the browser. A video that shows them
together has the same problem as any screenshot: the interface moves, and the video is out of date at the next release.
Editing it by hand again each time was never going to happen.

So the video is not edited. A script plays one story on the real tools, checks what each step left, and a second script
renders the video from the recording. Played without the camera, the same script is a test, and it runs every night.

<figure>
  <video src="/videos/showcase-teaser.mp4" poster="/screenshots/showcase-teaser-poster.jpg" autoplay loop muted playsinline controls aria-label="The showcase's teaser: a red CI run on the dashboard, Debug in my editor opening VS Code at the failing line, the test paused there, the right locator picked on the page, a missing step recorded, and the test passing."></video>
  <figcaption>The teaser, cut from the latest take: from a red CI run to a fixed test, without leaving the tools.</figcaption>
</figure>

## One story in five parts

The story is a small shop whose checkout was redesigned: **Place order** became **Pay now**, and a box to tick was
added. CI went red on `main`. From there the script plays twelve beats, in five parts:

1. **CI is red.** The failure page names the locator that broke, and the one that replaces it.
2. **Debug in VS Code.** **Debug in my editor** opens VS Code at the failing line and runs the test there, headed,
   until it stops at that line: VS Code, the test's page and Piwi Picker show the same place.
3. **Fix the test.** A pick on the page writes the right locator into the code, a recording adds the missing step, and
   the fixed test passes.
4. **Watch it run.** The test runs again, watched in VS Code's own panel, the editor marking the line it runs. The fix
   is pushed, CI runs it on three workers, and **Watch all** shows each one live. One is paused from the run page,
   waits there for a look, and is resumed until the run is green.
5. **Hand it to an agent.** A coding agent finishes a new test through Piwi's run tools.

Everything on screen is real: this commit's dashboard on a seeded database, the reporter built from source, VS Code
with the packaged extension, Chromium with the built Piwi Picker, and a real Playwright suite against a real app. The
"CI" runs are real headless runs of a fresh clone, told they run in CI. Only two parts of the machine are stood in for,
because a bare X server has none: the system's handler of `vscode://` links, and the browser's permission prompt that
pairing Piwi Picker asks for.

## A beat acts like a person, and waits on state

Each beat is a few lines of Playwright, which drives Chromium, the test's own browser and VS Code (an Electron app)
with trusted input, the same input a person's mouse and keyboard produce. Every click, key and palette command goes
through one helper that logs when it happened and the box it acted on, in screen pixels: that log is what the video
draws its cursor from.

A beat never sleeps. It waits for a state: a line on disk, a row in the dashboard's API, a CodeLens in the editor.
And every beat ends with a check that reads what the feature left behind, never what the script did:

```js
async check({ repo }) {
  const lines = read(repo.shop, PAGE_OBJECT).split('\n');
  expect(
    lines[FAILING_LINE - 1] === `    await this.page.${FIXED}.click();`,
    `line ${FAILING_LINE} clicks the picked locator: ${lines[FAILING_LINE - 1]}`,
  );
},
```

That is the whole point of the check mode. Each piece has its own tests, but nothing else drives the dashboard, the
language server, the VS Code extension, the browser extension and the reporter together, the way a person uses them.

## Filming, then cutting

A take plays the same beats, checks included, on a 4K virtual screen, at a person's pace: a pause before each gesture,
a delay between keys, each beat held until its subtitles have been read. ffmpeg records the whole screen losslessly,
and the take writes a log beside it: every gesture with its box, every window raised, when the test's browser came and
went, and a white square flashed once to tie the clock to the recording's frames.

The cut is not a video editor's timeline. A page renders each output frame from the recording and the log alone:
the camera moves to the window a gesture needs and eases there, but only when the move earns it (closer by at least
1.35×, never when the wide view already reads); the cursor is drawn from the logged points, with a ring where it clicks;
the subtitles are the beats' own lines; a quiet stretch plays at four times its speed with a badge. Because every
frame is computed from data, two renderers draw the same frame alike, and the motion is tested like any other function.

From one take come the full cut, a 45-second teaser, a clip per beat for the docs pages, the subtitles, the chapters
and a contact sheet. A take is six minutes; the cut, about half an hour on four cores. The nightly job can film it on
demand, on a runner that is not the developer's machine.

## What the nightly found

When I came back to the showcase, the nightly had been red for ten days. None of it was the script's own fault: each
failure was the product moving under it. A plain run no longer stops at the editor's breakpoints (only **Debug with
Piwi** does, as a debugger's Run and Debug do); the run controls had moved from the status bar to the editor's title;
the editor spelled a spec by its whole path. Each was a deliberate change, and each would have left a hand-made video
quietly wrong.

It also found what no unit test would: a pairing step that passed by accident, because a check for the word *Paired*
also matched *Not paired*; and four real bugs, each filed, two of them fixed since:

- the running line of a worker nobody watches named its call with Playwright's internal selector
  ([#1564](https://github.com/PiwiTests/piwi/issues/1564));
- a Playwright linked into the project's `node_modules`, as `npm link` does, read as not installed
  ([#1565](https://github.com/PiwiTests/piwi/issues/1565));
- the team's view of a paused test said its call had been running for longer and longer
  ([#1567](https://github.com/PiwiTests/piwi/issues/1567));
- a test stayed tinted as failing after the CI run that fixed it ([#1590](https://github.com/PiwiTests/piwi/issues/1590)).

A check never skips an assertion unconditionally. It skips one for a known bug only once it has seen that bug's state,
so the skip disappears by itself when the bug is fixed, and the video shows the fix at the next take.

## Making it readable

A video that moves between this many tools is easy to get lost in, so it carries its own table of contents. A card
before each part lists them all, ticks the ones done and names the next with a line on what it shows; a rail across
the top keeps the parts in view through the beats, the current one filling as it plays, with the beat's name beside
it. The same parts are the video's chapters, written in the form a video site reads from a description.

A 1080p video of a 4K screen leaves little room for chrome, so the showcase's VS Code shows the code and Piwi's marks,
little else: no activity bar, menu or breadcrumbs, no squiggles, Piwi's item alone in the status bar, the terminal
shrunk to a strip, and no notification but the one question the story answers. These are display settings of the
window, the same ones anyone can set; the tools and what they show are untouched.

## Where it lives

The script, the set and the renderer are in
[`apps/showcase`](https://github.com/PiwiTests/piwi/tree/main/apps/showcase), with the design record in
[`proposals/showcase-video.md`](https://github.com/PiwiTests/piwi/blob/main/proposals/showcase-video.md). The voice
track is the part still to build: the lines are already timed for it, since the subtitles come from them.

The video is a by-product. The useful part is a test that plays the product the way a person does, every night, and
says which step stopped working.
