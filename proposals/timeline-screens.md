# Screens on the test timeline

Playwright's trace viewer shows the page's screencast above its action list, so a reader sees what the page looked like
at any moment of the test. Piwi keeps those frames with every trace it stores, and no view read them. This proposal
puts them on the execution page's Timeline tab: as a lane on the time axis, and beside the list of steps and events
([PiwiTests/piwi#1561](https://github.com/PiwiTests/piwi/issues/1561)).

**Status.** Proposed 2026-11-19. Phases 1, 2 and 3 are built.

- **Built:** the server reads the trace's `screencast-frame` events, in both shapes, and places them on the wall clock
  the timeline reads. `GET /api/test-run-cases/:id/trace-frames` lists them page by page, with the trace's test start,
  and `GET /api/test-run-cases/:id/trace-frame?name=` serves one; the demo answers both from its committed traces. The
  timeline has the Screen lane (hover, click, Screen toggle), drag to zoom, and the page panel beside the step list
  from `xl` (under the tapped row below it), with rows and bars marking each other on hover.
- **Changed while building:** the failing step keeps its "Page at the failing step" block (DOM, accessibility tree,
  picker) in its row, and the panel opens on the failing step before it ran rather than at the failure, so the two
  never show the same image. The panel shows from `xl`, not `lg`: below 1280 px the table has no room beside it.
  Frames of a trace recorded at another time than its execution (a fixture, a demo trace) are placed by the trace's
  test start.
- **Left:** a tolerant "no visual change" comparison (below), and the lane on passing executions.
- **Decided:** the event list shows the page in a side panel, not in a hover card or a thumbnail column.

## What a trace holds

| Source                 | Recorded when                                                           | What it gives                                                          |
| ---------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Screencast frames      | Any trace with `screenshots`, Playwright's default for every trace mode | A JPEG whenever the page paints something new, with its time, per page |
| Per-action screenshots | Playwright 1.63+ with `snapshots.screen`                                | An exact image before and after each action                            |
| Video                  | `video` on                                                              | Every moment, already aligned to the actions by `/video-actions`       |
| Failure screenshot     | `screenshot: 'only-on-failure'`                                         | One image, at the failure                                              |

A frame is an event of a browser context's `.trace` file: `{ pageId, width, height, timestamp }` with the image in
`resources/<sha1>` before 1.63 (`sha1`) and in its own `screencast/` entry from 1.63 (`file`). Ingestion keeps the
first in the slim ZIP (its name is not the SHA-1 of its bytes) and moves the second to the project's pool.
`timestamp` is on the trace's own clock; the browser context's header (`wallTime`, `monotonicTime`) puts it on the
wall clock, as the video marks do (`wallClockOf`).

## Design

- **Phase 1, server.** `screencastFrames` on the parsed trace (`trace-events.ts`), `buildTraceFrames`,
  `traceFrameSource` and `traceImageContentType` in `trace-insights.ts` (node-free, so the demo calls them too), and
  the two routes. A frame list past 1,000 frames is an even sample of each page, its last frame kept. The frame route
  serves only a name the trace's events list, and only an image.
- **Phase 2, the Screen lane.** A Screen chip in the type filter and a lane on top of the axis. Hovering the axis shows
  the page at that moment and the step running then; dragging zooms; a click keeps a moment, and arrow keys move to
  the previous or next change. A click on a frame opens `ScreenshotLightbox` there. A 1.63 trace's per-action shots
  take their exact place in the lane, and the "Before each step" filmstrip goes. The lane loads in the browser after
  the axis, only the tiles in view.
- **Phase 3, the side panel.** From `xl`, a sticky panel beside the list shows the page for the hovered row, else the
  picked one (a row's time, the row itself, or a frame the panel's arrows moved to): before and after for a step, with
  a line when no new frame was painted while it ran; the page at its time for a request, a console line or a dialog.
  It opens on the failing step before it ran. Below `xl` a row's time opens it under the row. Rows and bars highlight
  each other on hover.

## Open questions

- **Visual change.** A focused field's caret repaints the page every 500 ms, so byte-identical frames are rare and
  "No change for 28 s" needs a tolerant comparison (a small grayscale signature per frame). Where it runs, server or
  browser, is decided with phase 2.
- **Several pages.** One lane per page, or one lane that follows the page the current step acts on.
- **Passing executions.** They have no axis today; whether they get the lane and the panel.
