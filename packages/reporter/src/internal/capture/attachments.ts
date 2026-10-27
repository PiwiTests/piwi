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

/** The content type the capture fixtures write an attachment with: `text/plain` for the ARIA snapshot, JSON otherwise. */
function contentTypeOf(name: AttachmentName): string {
  return name === ATTACHMENT_NAMES.ariaSnapshot ? 'text/plain' : 'application/json';
}

/**
 * Whether `attachment` is the capture fixtures' `name` attachment: that name
 * with the content type they write it with. A browser server's
 * `x-playwright-attachment` headers make `text/plain` attachments of any name.
 */
export function isPiwiAttachment(attachment: { name: string; contentType?: string }, name: AttachmentName): boolean {
  return attachment.name === name && attachment.contentType === contentTypeOf(name);
}

/**
 * The capture fixtures' `name` attachment of a test result. The fixtures write
 * each at most once, as the test ends, so the last match is theirs: a
 * header-made attachment arrives at context creation, before it.
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
