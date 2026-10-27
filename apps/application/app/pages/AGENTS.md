# Pages: agent guide

Rules for the layout of the dashboard's pages (`app/pages/`). Read [`../AGENTS.md`](../AGENTS.md) first.

## Page layout

- **One page gutter, set once.** The `UDashboardPanel` body (`dashboardPanel.slots.body` in `app/app.config.ts`) is
  every page's gutter: 16 px around and between its direct children from `sm` up, none below `sm`, where cards and
  blocks go full-bleed (`max-sm:rounded-none max-sm:border-x-0`). A page never pads its body again (no `p-4` or `p-6`
  wrapper, no `:ui` body override), spaces its top-level blocks with `gap-4` / `space-y-4`, and narrows with `max-w-*`,
  never with padding.
- **Below `sm`, top-level content that is not a full-bleed card is wrapped in `max-sm:px-4`** (a loose heading,
  sentence or select), so nothing touches the screen edge.
- **A page-level tab strip is `UDashboardToolbar` + `UNavigationMenu` with `highlight`, as `DetailPageLayout` renders
  it.** A page on `DetailPageLayout` never touches the strip, and no other page-level strip (a `UTabs` pill, a
  hand-rolled tablist) is introduced. A switch inside a card (the MCP page's client picker) may differ.
- **The strip is a navigation menu, not an ARIA tablist**: panels carry no `tabpanel` role, the active item carries
  `aria-current`, and the active tab's `HelpHint` renders beside the strip, never inside a trigger's label (that nests
  buttons).
- **The strip scrolls as one row and becomes a `USelect` on a phone**: it carries
  `:ui="{ list: 'overflow-x-auto', root: 'min-w-0', item: 'shrink-0' }"` instead of shrinking every label to an
  ellipsis, and below `sm` it is `hidden sm:flex` beside a full-width `USelect`. `DetailPageLayout` does both.
- **A tab whose content scrolls itself** passes `DetailPageLayout` a `tabPanelClass` of `overflow-hidden flex flex-col`
  instead of the default `overflow-y-auto`.
- **A settings surface with many sections uses a vertical section menu, never a horizontal strip.** Settings
  (`pages/settings.vue`, one route per page) and a project's Settings tab (`ProjectSettingsPanel.vue`, one `?section=`
  per section) show a vertical `UNavigationMenu` grouped by `{ type: 'label' }` rows beside the content from `lg` up,
  and a `USelect` grouped the same way below. A new page is an entry of `SETTINGS_PAGES`, a new project section an
  entry of the panel's `SECTION_IDS`.
