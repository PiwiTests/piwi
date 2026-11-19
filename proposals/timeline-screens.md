# Screens on the test timeline

Playwright's trace viewer shows the page's screencast above its action list, so a reader sees what the page looked like
at any moment of the test. Piwi keeps those frames with every trace it stores, and no view read them. This proposal
puts them on the execution page's Timeline tab: as a lane on the time axis, and beside the list of steps and events
([PiwiTests/piwi#1561](https://github.com/PiwiTests/piwi/issues/1561)).

**Status.** Proposed 2026-11-19. Phase 1 is built.

- **Built:** the server reads the trace's `screencast-frame` events, in both shapes, and places them on the wall clock
  the timeline reads. `GET /api/test-run-cases/:id/trace-frames` lists them page by page, and
  `GET /api/test-run-cases/:id/trace-frame?name=` serves one. The demo answers both from its committed traces.
- **Left:** the Screen lane (phase 2) and the side panel beside the event list (phase 3).
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
- **Phase 3, the side panel.** From `lg`, a sticky panel beside the list shows the page for the hovered row, else the
  clicked one: before and after for a step, with a sentence when the page did not change during it; the page at its
  time for a request, a console line or a dialog. It opens on the failing step, at the failure, and takes over the
  failing step's "Page at the failing step" block. Below `lg` it opens under the tapped row. Rows and bars highlight
  each other on hover.

## Open questions

- **Visual change.** A focused field's caret repaints the page every 500 ms, so byte-identical frames are rare and
  "No change for 28 s" needs a tolerant comparison (a small grayscale signature per frame). Where it runs, server or
  browser, is decided with phase 2.
- **The sample data's clock.** The seed moves its executions to the present, while the committed traces keep the time
  they were recorded at, so their frames fall outside the seeded timelines. Phase 2 places them for the demo and the
  dev seed, or records traces that match the stories.
- **Several pages.** One lane per page, or one lane that follows the page the current step acts on.
- **Passing executions.** They have no axis today; whether they get the lane and the panel.
