export default defineAppConfig({
  ui: {
    colors: {
      primary: 'violet',
      neutral: 'zinc',
      // The brand violet: the accent of the logo, the browser extension and
      // the editor plugins. Statuses use calmer hues than the raw defaults:
      // emerald (the mint of the logo's check), rose and amber keep the usual
      // meaning with a softer, more even palette than green/red/yellow.
      success: 'emerald',
      error: 'rose',
      warning: 'amber',
      // Test outcome palette (see `--color-status-*` in main.css): flaky is
      // fuchsia, apart from the violet accent and the amber of "didn't run"
      // and warnings.
      flaky: 'fuchsia',
    },
    card: {
      slots: {
        // Below `sm` a card goes full-bleed: no page gutter, no side border and no
        // side radius, so text starts 12 px from the screen edge on its own inner
        // padding. Top and bottom borders stay. From `sm` up the Nuxt UI default
        // (bordered, rounded, `p-6`) applies unchanged.
        root: 'max-sm:rounded-none max-sm:border-x-0',
        // Solid muted header so block headers clearly separate from the card body
        // in both modes (zinc-100 on white / zinc-800 on zinc-900). Below `sm` the
        // header adds 12 px per side; from `sm` up it is `px-6`.
        header: 'px-3 py-3 sm:px-6 bg-muted',
        body: 'max-sm:p-3',
        footer: 'max-sm:p-3',
      },
    },
    dashboardPanel: {
      slots: {
        // At least as tall as the space under the demo's banner (`--demo-banner-height`,
        // unset outside the demo), where the dashboard sits.
        root: 'min-h-[calc(100svh-var(--demo-banner-height,0px))]',
        // Below `sm` the page has no side gutter: cards are full-bleed and their own
        // 12 px padding is the only inset. Vertical padding and the `sm`-and-up
        // default (`p-6`) are the Nuxt UI defaults.
        body: 'max-sm:px-0',
      },
    },
    table: {
      slots: {
        // Reduce default table cell padding globally (default is px-4 py-3.5 / p-4)
        th: 'px-3 py-2',
        td: 'px-3 py-2',
      },
    },
  },
});
