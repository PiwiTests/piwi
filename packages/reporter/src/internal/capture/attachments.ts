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
  browserCoverage: 'piwi-browser-coverage',
  browserFunctions: 'piwi-browser-functions',
  cssCoverage: 'piwi-css-coverage',
  cssRules: 'piwi-css-rules',
  serverCoverageRequests: 'piwi-server-coverage-requests',
  webVitals: 'piwi-web-vitals',
  locatorSuggestion: 'piwi-locator-suggestion',
  pageState: 'piwi-page-state',
  userPick: 'piwi-user-pick',
  aiUsage: 'piwi-ai-usage',
  aiMeta: 'piwi-ai-meta',
  resources: 'piwi-resources',
  pauses: 'piwi-pauses',
} as const;

/** Set of every internal attachment name — used to skip them when collecting user attachments. */
export const INTERNAL_ATTACHMENT_NAMES: ReadonlySet<string> = new Set(Object.values(ATTACHMENT_NAMES));

/** A name of `ATTACHMENT_NAMES`. */
export type AttachmentName = (typeof ATTACHMENT_NAMES)[keyof typeof ATTACHMENT_NAMES];

/**
 * The content type the capture fixtures write `piwi-aria-snapshot` with, and
 * the only one the reporter reads it with. An attachment made from a browser
 * server's `x-playwright-attachment` header has the content type `text/plain`.
 */
export const ARIA_SNAPSHOT_CONTENT_TYPE = 'text/plain; charset=utf-8';

/** The content type the capture fixtures write an attachment with: `ARIA_SNAPSHOT_CONTENT_TYPE` for the ARIA snapshot, JSON otherwise. */
function contentTypeOf(name: AttachmentName): string {
  return name === ATTACHMENT_NAMES.ariaSnapshot ? ARIA_SNAPSHOT_CONTENT_TYPE : 'application/json';
}

/** Whether `attachment` has the name `name` and the content type the capture fixtures write it with. */
export function isPiwiAttachment(attachment: { name: string; contentType?: string }, name: AttachmentName): boolean {
  return attachment.name === name && attachment.contentType === contentTypeOf(name);
}

/**
 * The last of `attachments` that `isPiwiAttachment` accepts for `name`. A
 * reader of an attachment the fixtures write more than once
 * (`piwi-browser-functions`, `piwi-css-rules`) goes through every match with
 * `isPiwiAttachment` instead.
 */
export function findPiwiAttachment<T extends { name: string; contentType?: string }>(
  attachments: readonly T[] | undefined,
  name: AttachmentName,
): T | undefined {
  for (let i = (attachments?.length ?? 0) - 1; i >= 0; i--) {
    if (isPiwiAttachment(attachments![i]!, name)) return attachments![i];
  }
  return undefined;
}

/**
 * The screenshot of the page a failed test last acted on. Not an internal
 * name: it is uploaded as a file with the test's other attachments.
 */
export { FAILURE_SCREENSHOT_ATTACHMENT } from '@piwitests/core/wire';

/** Annotation type that surfaces a locator-healing suggestion in the report/trace. */
export const LOCATOR_SUGGESTION_ANNOTATION = ATTACHMENT_NAMES.locatorSuggestion;

/** Annotation type that surfaces a human-confirmed replacement locator in the report/trace. */
export const USER_PICK_ANNOTATION = ATTACHMENT_NAMES.userPick;
