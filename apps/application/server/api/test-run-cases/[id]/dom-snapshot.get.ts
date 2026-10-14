import { and, eq } from 'drizzle-orm';
import { files, testRunsCases } from '../../../database/schema';
import { resolveCaseDomSnapshot } from '../../../utils/dom-snapshot';
import { snapshotMomentFromQuery } from '../../../utils/dom-snapshot-render';
import { resolveCasePayloadContents } from '../../../utils/case-payloads';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Render the failure-time DOM snapshot for a test-run case',
    description:
      'Extracts the DOM snapshot from the stored trace ZIP, falling back to a nested render of the captured ARIA snapshot when no trace is available. Pass `source=aria` to render the ARIA tree even when a trace exists. The page is rendered as recorded, with field values, checkbox and option states, open dialogs and shadow roots; a password field’s value is masked, inline handlers and script bodies are never included, and token-shaped strings are masked. `data-piwi-*` attributes mark what only a script can restore: scroll offsets (`data-piwi-scroll-top`, `data-piwi-scroll-left`), a modal dialog (`data-piwi-modal`), an open popover (`data-piwi-popover-open`), the element the action targeted (`data-piwi-target`) and the custom elements the page defined (`data-piwi-custom-elements`).',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
      {
        name: 'source',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['dom', 'aria'] },
        description: 'Which representation to render — trace-derived DOM (default) or the ARIA tree',
      },
      {
        name: 'callId',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Render this trace action’s snapshot first (with `phase`; at most 200 characters), such as the one a trace screenshot was taken at; falls back to the failure-time snapshot when the trace holds none for it',
      },
      {
        name: 'phase',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['before', 'after'] },
        description: 'Which snapshot of the `callId` action: before it ran or after it',
      },
      {
        name: 'inlineStyles',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['1', 'true'] },
        description:
          "Inline the trace's stylesheets and images so the returned HTML renders as recorded on its own; the rendered page views load `dom-snapshot-frame`, which always does",
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');

  // Authorize by the execution's own project: this id may be opened from the
  // cluster page, where it can belong to a run in another project.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  const query = getQuery(event);
  const sourceParam = query.source;
  const source = sourceParam === 'aria' || sourceParam === 'dom' ? sourceParam : undefined;
  // Inlining makes the returned HTML self-contained; without it the HTML stays
  // lean, as the rendered views (served by `dom-snapshot-frame`) and text readers want.
  const inlineStyles = query.inlineStyles === '1' || query.inlineStyles === 'true';

  const [traceRows, caseRows] = await Promise.all([
    db
      .select({ path: files.path })
      .from(files)
      .where(and(eq(files.testRunsCaseId, id), eq(files.type, 'trace')))
      .limit(1),
    db
      .select({ aria: testRunsCases.ariaSnapshot, ariaPayloadId: testRunsCases.ariaSnapshotPayloadId })
      .from(testRunsCases)
      .where(eq(testRunsCases.id, id))
      .limit(1),
  ]);

  // ARIA is content-addressed on new rows; legacy rows keep it inline.
  const payloadContents = await resolveCasePayloadContents(db, [caseRows[0]?.ariaPayloadId]);
  const aria =
    (caseRows[0]?.ariaPayloadId != null ? payloadContents.get(caseRows[0].ariaPayloadId) : undefined) ??
    caseRows[0]?.aria ??
    null;

  return resolveCaseDomSnapshot(traceRows[0]?.path ?? null, aria, undefined, {
    source,
    inlineStyles,
    at: snapshotMomentFromQuery(query),
  });
});
