/**
 * What the page was doing at test end beyond its DOM (focus, hover, selection,
 * indeterminate checkboxes) and the element path that names an element. The
 * pure implementation lives in `@piwitests/core` (shared with the reporter that
 * captures it); this file re-exports it for `#shared/page-interaction`.
 */
export * from '@piwitests/core/page-interaction';
