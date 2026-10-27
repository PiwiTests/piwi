# Run page components: agent guide

Rules for the run page's components (`app/components/run/`). Read [`../../AGENTS.md`](../../AGENTS.md) first.

## Workers timeline rendering

A run's timeline draws one SVG shape per test, hook section and gap — thousands on a large run — and a zoom
re-positions each drawn one. Keep every interaction proportional to what changed:

- Hover state lives in one reactive object that only `TimelineTooltip` and `TimelineFocus` read; `WorkersTimeline`'s
  template passes the object, never its fields, so hovering never re-renders the bars.
- Dim the other bars with `TimelineFocus` (one wash plus a copy of the hovered bar), never with per-bar classes,
  styles or a `:has(:hover)` rule, which restyle every shape on each hover.
- Bar props stay referentially stable when nothing changed (`NO_LOCK_COLORS`, `NO_HOOKS`, `timelineStatusFill`); a
  fresh `[]` or `{}` per render re-renders every bar.
- A test's hook sections and its stops at the pause bar (its `pause` step events) are drawn by the test's own
  `TimelineBar`, not as bars of their own; only bars inside the viewport's `renderRange` are drawn.
- The resource tracks (`TimelineResourceBand`) and the strips under each worker (`TimelineWorkerStrips`) build each
  path once in milliseconds and take the zoom from their group's `scale()` transform, so a zoom never rebuilds them.
  Their hover lives in its own reactive object, read only by `TimelineResourceTooltip` and `TimelineResourceCursor`.
  Where every lane, band and strip sits comes from one `layOutTimelineRows` (`app/utils/resource-tracks.ts`), which
  the viewport reads through `laneOffset`; anything new drawn between the lanes is added there, never offset by hand.
