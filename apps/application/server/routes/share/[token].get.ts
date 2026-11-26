import { collectClusterBundle, collectExecutionBundle } from '#shared/export/collect';
import { buildExport } from '#shared/export/build';
import { renderReportHtml } from '#shared/reports/render-html';
import { sentencesFor } from '#shared/reports/sentences';
import { resolveExportBudget, resolveExportMaxCases, serverAssetReader } from '../../utils/export-assets';
import { exportSourceUrl } from '../../utils/export-request';
import { recordShareLinkView } from '../../utils/share-links';
import {
  LIVE_DASHBOARD_REFRESH_SECONDS,
  openShareLink,
  setShareDocumentHeaders,
  shareLinkReport,
} from '../../utils/share-view';

/**
 * The public face of a share link. An execution or a failure cluster renders
 * as the offline export's self-contained HTML, resolved live at view time,
 * with its evidence inlined under the export size budget. A report link
 * renders its snapshot's stored quality report; a live dashboard link renders
 * the saved dashboard as a quality report computed now, reloading itself
 * every minute. No session, no cookies, no follow-up requests.
 */
export default eventHandler(async (event) => {
  const opened = await openShareLink(event, { gonePage: true });
  if ('gone' in opened) return opened.gone;
  const { db, link } = opened;

  let bytes: Uint8Array;
  let contentType: string;
  if (link.entityKind === 'report' || link.entityKind === 'dashboard') {
    const report = await shareLinkReport(db, link);
    // The snapshot was pruned, the dashboard deleted, or its minter lost access —
    // indistinguishable from an unknown token by design.
    if (!report) throw apiError({ statusCode: 404, message: 'Not found' });
    const s = sentencesFor(report.bundle.language);
    const doc = renderReportHtml(
      report.bundle,
      report.live ? { refreshSeconds: LIVE_DASHBOARD_REFRESH_SECONDS, banner: s.labels.liveDashboard } : {},
    );
    bytes = new TextEncoder().encode(doc);
    contentType = 'text/html; charset=utf-8';
  } else {
    const bundle =
      link.entityKind === 'cluster'
        ? await collectClusterBundle(db, link.entityId, {
            maxCases: resolveExportMaxCases(),
            sourceUrl: exportSourceUrl(event, `/failure-clusters/${link.entityId}`),
          })
        : await collectExecutionBundle(db, link.entityId, {
            maxCases: 1,
            sourceUrl: exportSourceUrl(event, `/test-run-cases/${link.entityId}`),
          });
    // The entity was pruned (retention) or deleted — indistinguishable from an
    // unknown token by design.
    if (!bundle) throw apiError({ statusCode: 404, message: 'Not found' });
    const built = await buildExport(bundle, 'html', link.entityId, {
      reader: serverAssetReader,
      budget: resolveExportBudget(),
    });
    bytes = built.bytes;
    contentType = built.contentType;
  }

  await recordShareLinkView(db, link.id);
  setShareDocumentHeaders(event, contentType, bytes.length);
  return Buffer.from(bytes);
});
