# Room for a run's tests

- Status: accepted
- Date: 2026-10-24

A change to the run page and to every page's margins, made because the run's Tests list was often a few rows tall on a
laptop screen. At 1366×720 the run page used about 430 px for the navbar, a 28 px gutter, a header whose count bar
took two rows (the bar, then a line of counts), the tab strip, the search and a row of six outcome chips before the
first test row. The gutters also differed from page to page, from 24 to 48 px, because several pages padded their body
again on top of the dashboard panel's own padding.

**Status.** Built 2026-10-24 in one pull request. It amends two points of
[`ui-simplification.md`](ui-simplification.md), listed under Consequences; the rest of that record stands.

## Decisions

- **One page gutter, set once.** The `UDashboardPanel` body (`dashboardPanel.slots.body` in `app/app.config.ts`) is
  every page's gutter: 16 px around the content and between its blocks from `sm` up, and no side gutter below `sm`,
  where cards and blocks go full-bleed. A page never pads its body content again; a reading page narrows with
  `max-w-*` and `mx-auto`. The rule is in `apps/application/AGENTS.md` (Other UI rules).
- **The counts are written on the count bar.** The bar is 24 px tall and each segment writes its count, followed by
  its label when the segment is wide enough, else a short label (`flaky` for passed on retry, `dnr` for didn't run),
  else the count alone. The browser measures the text against each segment's width; before hydration, a label that
  does not fit wraps out of the segment's one clipped line. The row of counts under the bar is gone.
- **A selected segment shows it.** It carries an inner ring, widens to its whole label when the bar has room for it,
  and the segments the filter leaves out fade. A selected outcome whose count drops to zero keeps a segment, so the
  filter can still be turned off. The bar stays a pill; its end segments round their outer corners, so a selected or
  focused end keeps the curve.
- **The count bar is the run's outcome filter.** The Tests tab has no outcome chips: they repeated the bar's segments,
  and the bar shows the counts besides. *New regressions* and *Newly flaky* stay beside the search as toggles, and
  *Clear filters* sits on the list header, next to the count it explains. The project's Tests tab keeps its outcome
  chips (it has no count bar), on the search's row when they fit.

## Consequences

- **Amends [`ui-simplification.md`](ui-simplification.md) §6.2**: "the T/P/F/S/DNR/Fl abbreviations go". The bar
  writes `dnr` and `flaky` only on a segment too narrow for the whole label; the segment's accessible name starts with
  that text and goes on with the whole label (*1 flaky, passed on retry*), and its tooltip gives the whole label.
- **Amends [`ui-simplification.md`](ui-simplification.md) §6.3**: "Filters: search, five status chips, *New
  regressions* and *Newly flaky*". The run's Tests tab drops the status chips; the header's count bar filters by
  outcome. Below `lg`, *Hide summary* folds the bar away with the rest of the header, and *Clear filters* on the list
  header is then what shows that a status filter is on.
- **Contrast.** The counts are white with a light shadow on the outcome colors. On the green, amber and light-grey
  segments that is about 2.5:1, below WCAG AA for small text; the accessible name and the tooltip carry every count
  and label. Fixme keeps dark text in dark mode, where its grey is light. The text color is `onBg` in
  `STATUS_PALETTE` (`app/utils/status-palette.ts`).
- **More fits above the fold**, so the execution and failure cluster pages show more of the blocks under their
  situation block on the first screen. Their budget (`npm run app:measure -- --check`) counts the controls of the
  navbar and the situation block, which the gutter does not change, and every page holds it.
