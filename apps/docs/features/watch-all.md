---
title: Watch all workers
description: 'See every worker of a running Playwright run at once on its run page, an image a second each, and let the live view follow the worker whose test failed, got stuck or stopped, saying why.'
lang: en-US
---

# Watch all workers

<Needs reporter fixtures />

**Watch all**, on a running run's **Tests** tab, shows a tile for each worker in the run's
[live view](./live-view): the page its test is on, one image a second, with the worker's number, its test and the step
it is on. A click on a tile shows that worker in full, in the panel **Watch** opens. It is for a run of many workers
where you do not know yet which one to look at. It needs what the live view needs: the project's live view on, and a
CI run or a run [shared from a developer's machine](./share-live).

## What a tile shows

- **The page**, as the worker's test sees it: one image a second, 320 pixels wide, the latest alone. A still page sends
  none until it changes.
- **The worker**, by its lane (`Worker 2`, as the rows and the Timeline name it), the test it runs and its step.
- **What its test needs attention for**: where it stands stopped (`Stopped at a breakpoint`), or **Stuck?** once the
  dashboard marks it ([Stuck tests](./stuck-tests)).

The tile of the worker shown in full is outlined. A worker that leaves the run's live view leaves the grid; the one
Playwright starts in its lane after a failure takes its place.

## Follow what needs attention

In the full view, **Follow what needs attention** moves the view on its own to a worker whose test failed, was marked
**Stuck?**, or stopped (a breakpoint, a `page.pause()` or **Pause**), and says why it moved:
`Moved to worker 3: “pays with a saved card” failed.` It follows these rules:

- It goes where the newest of them happened, in another worker of the run's live view.
- It stays at least 5 seconds after it moved or you chose a worker yourself (a tile, a row's **Watch**).
- It stays on a worker that needs attention itself: one stopped or marked **Stuck?**, for as long as it lasts, and one
  whose test failed, for 10 seconds.
- A failure from before you turned it on, or that the run page saw more than 30 seconds ago, the view open or closed,
  moves nothing; nor does anything from before you last chose a worker yourself.

After a failure, Playwright starts a new worker in the lane: the view shows its next test, and the line under its
checkboxes says which test failed. The view moves within its panel, which stays in full screen if you put it there.

## One connection

The run page holds one connection to the dashboard for everything it watches: the tiles and the full view travel
together, and showing another worker or resizing the panel changes what it carries without opening another. The full
view's images come at the size the panel shows them, up to 1280 by 800 pixels; a worker shown in full and as a tile
sends the larger. Each worker sends images only while a page shows it, in full or as a tile, and nothing is stored:
[what is sent, to whom, and what is kept](./live-view#what-is-sent-to-whom-and-what-is-kept) applies to every tile.

A run takes 16 such pages at a time, whatever each shows, and its workers send 4 MB of images a second at most
together. An older reporter sends its images at 640 by 400 pixels, four a second, whatever the view asks; the
dashboard passes one a second of them to a tile.

## In the demo

The live demo runs no browser: **Watch all** on a simulated run shows each running worker's step where its image
would be, and its stops and **Stuck?** marks.

## Related

- [Live view of a run](./live-view): turning it on, and the full view of one worker
- [Stuck tests](./stuck-tests): when a test is marked **Stuck?**
- [Share a run live](./share-live): let a teammate watch a run on your machine
- [Watch a run](./watch-a-run): where a run is followed, on every tool
