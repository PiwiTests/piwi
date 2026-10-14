import { randomBytes } from 'node:crypto';
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
import { buildPickerDocument, buildReadonlyDocument } from '#shared/snapshot-picker-document';
import { CAPTURED_ATTRIBUTES } from '#shared/locator-generation';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Serve the failure-time DOM snapshot as a sandboxed picker/readonly frame',
    description:
      'Returns the failure-time DOM snapshot wrapped as a self-contained HTML document — the interactive locator picker (`mode=pick`, the default) or the read-only render (`mode=readonly`) — served with a `Content-Security-Policy` that sandboxes it (`sandbox allow-scripts`), runs only its own nonce-marked script and loads nothing from the network: the stylesheets and images captured in the trace are embedded as `data:` URIs and every other subresource reference is removed. It is loaded via an iframe `src` (not `srcdoc`) so the frame carries its own CSP instead of inheriting the dashboard page policy, which in the desktop shell blocks the inline picker script. Same snapshot resolution and rendering as `dom-snapshot`; the frame’s script then puts back the state the `data-piwi-*` attributes mark (scroll offsets, a modal dialog, an open popover, the action’s target outlined, a dot where the mouse was with the element under it styled as hovered; on the failure-time snapshot, the focused and hovered elements styled as `:focus` and `:hover`, a text selection highlighted, indeterminate checkboxes) and reports to the host, over `postMessage`, its content height and where to scroll (`piwiScrollTo`). A password field’s value is masked, inline handlers and script bodies are never included, and token-shaped strings are masked.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
      {
        name: 'mode',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['pick', 'readonly'] },
        description: 'Interactive locator picker (default) or the read-only render',
      },
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
    ],
    'x-required-permission': 'project:read',
  },
});

// A minimal valid document for the "no snapshot" case, so the iframe renders a
// blank frame rather than erroring. The client only points the frame here once
// its metadata fetch reports a snapshot exists, so this is a defensive fallback.
const EMPTY_DOC =
  '<!doctype html><html><head><meta charset="utf-8"><title>No snapshot</title></head><body></body></html>';

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');

  // Authorize by the execution's own project (as the JSON endpoint does): this
  // id may be opened from the cluster page, where it can belong to another project.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  const query = getQuery(event);
  const sourceParam = query.source;
  const source = sourceParam === 'aria' || sourceParam === 'dom' ? sourceParam : undefined;
  const mode = query.mode === 'readonly' ? 'readonly' : 'pick';

  // Same load as `dom-snapshot.get.ts` (kept in step with it): the case's trace
  // blob and its ARIA snapshot (content-addressed on new rows, inline on legacy).
  const [traceRows, caseRows] = await Promise.all([
    db
      .select({ path: files.path })
      .from(files)
      .where(and(eq(files.testRunsCaseId, id), eq(files.type, 'trace')))
      .limit(1),
    db
      .select({
        aria: testRunsCases.ariaSnapshot,
        ariaPayloadId: testRunsCases.ariaSnapshotPayloadId,
        pageState: testRunsCases.pageState,
      })
      .from(testRunsCases)
      .where(eq(testRunsCases.id, id))
      .limit(1),
  ]);
  const payloadContents = await resolveCasePayloadContents(db, [caseRows[0]?.ariaPayloadId]);
  const aria =
    (caseRows[0]?.ariaPayloadId != null ? payloadContents.get(caseRows[0].ariaPayloadId) : undefined) ??
    caseRows[0]?.aria ??
    null;

  // Both the picker and the read-only card render the page here, so embed the
  // trace's stylesheets and images for the opaque-origin, offline frame.
  const result = await resolveCaseDomSnapshot(traceRows[0]?.path ?? null, aria, undefined, {
    source,
    inlineStyles: true,
    at: snapshotMomentFromQuery(query),
    pageState: caseRows[0]?.pageState,
  });

  // Sandbox the untrusted snapshot HTML: an opaque origin with scripts allowed,
  // matching the iframe’s own `sandbox="allow-scripts"`. Only the nonce-marked
  // builder script runs, and nothing loads from the network — the document
  // carries its stylesheets and images inline, so any fetch left in the snapshot
  // is blocked rather than sent to this origin or the tested app. Because this
  // is served over HTTP (not `srcdoc`), the frame carries THIS policy instead of
  // inheriting the dashboard page's `strict-dynamic` CSP, which would block the
  // inline picker script.
  const nonce = randomBytes(16).toString('base64');
  setResponseHeader(
    event,
    'Content-Security-Policy',
    [
      'sandbox allow-scripts',
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      'media-src data:',
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  );
  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8');
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Cache-Control', 'no-store');

  if (result.status !== 'ok' || !result.html) return EMPTY_DOC;
  return mode === 'readonly'
    ? buildReadonlyDocument(result.html, nonce)
    : buildPickerDocument(result.html, { probedAttrs: CAPTURED_ATTRIBUTES }, nonce);
});
