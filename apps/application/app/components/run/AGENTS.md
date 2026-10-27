# Run page components: agent guide

Rules for the run page's components (`app/components/run/`). Read [`../../AGENTS.md`](../../AGENTS.md) first.

## Workers timeline rendering

A run's timeline draws one SVG shape per test, hook section and gap (thousands on a large run), and a zoom re-positions
each drawn one. Keep every interaction proportional to what changed:

- **Hovering never re-renders the bars**: the hover state is one reactive object that only `TimelineTooltip` and
  `TimelineFocus` read, and `WorkersTimeline`'s template passes the object, never its fields.
- **Dim the other bars with `TimelineFocus`** (one wash plus a copy of the hovered bar), never with per-bar classes,
  styles or a `:has(:hover)` rule, which restyle every shape on each hover.
- **Bar props stay referentially stable when nothing changed** (`NO_LOCK_COLORS`, `NO_HOOKS`, `timelineStatusFill`): a
  fresh `[]` or `{}` per render re-renders every bar.
- **A test's hook sections and its stops at the pause bar (its `pause` step events) are drawn by the test's own
  `TimelineBar`**, not as bars of their own, and only bars inside the viewport's `renderRange` are drawn.
- **A zoom never rebuilds the resource tracks** (`TimelineResourceBand`) or the strips under each worker
  (`TimelineWorkerStrips`): each path is built once in milliseconds and takes the zoom from its group's `scale()`
  transform. Their hover is its own reactive object, read only by `TimelineResourceTooltip` and
  `TimelineResourceCursor`.
- **Every lane, band and strip is placed by `layOutTimelineRows`** (`app/utils/resource-tracks.ts`), which the viewport
  reads through `laneOffset`: anything new drawn between the lanes is added there, never offset by hand.
