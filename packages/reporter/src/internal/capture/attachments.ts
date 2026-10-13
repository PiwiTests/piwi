/**
 * Names of the `testInfo` attachments the dashboard fixtures produce and the
 * reporter parses. Single source of truth — imported by the producer
 * (`capture-fixtures.ts`), the consumers (`reporter.ts` / `file-handler.ts`), and
 * the dogfooding `application/tests/fixtures.ts`, so producer and consumer can
 * never drift on a name.
 */
export const ATTACHMENT_NAMES = {
  locators: 'piwi-locators',
  ariaSnapshot: 'piwi-aria-snapshot',
  ariaSnapshotJson: 'piwi-aria-snapshot-json',
  console: 'piwi-console',
  dialogs: 'piwi-dialogs',
  network: 'piwi-network',
  pageInventory: 'piwi-page-inventory',
  locatorPages: 'piwi-locator-pages',
  codeReach: 'piwi-code-reach',
  webVitals: 'piwi-web-vitals',
  locatorSuggestion: 'piwi-locator-suggestion',
  pageState: 'piwi-page-state',
  userPick: 'piwi-user-pick',
  aiUsage: 'piwi-ai-usage',
  aiMeta: 'piwi-ai-meta',
  resources: 'piwi-resources',
  pause: 'piwi-pause',
} as const;

/** Set of every internal attachment name — used to skip them when collecting user attachments. */
export const INTERNAL_ATTACHMENT_NAMES: ReadonlySet<string> = new Set(Object.values(ATTACHMENT_NAMES));

/** Annotation type that surfaces a locator-healing suggestion in the report/trace. */
export const LOCATOR_SUGGESTION_ANNOTATION = ATTACHMENT_NAMES.locatorSuggestion;

/** Annotation type that surfaces a human-confirmed replacement locator in the report/trace. */
export const USER_PICK_ANNOTATION = ATTACHMENT_NAMES.userPick;
