import { emailTrendBlock } from '#shared/reports/render-email';
import { chartPng } from '../../../utils/reports/chart-png';
import { openShareLink, shareLinkReport } from '../../../utils/share-view';

/**
 * The trend of a report or a live dashboard link as a PNG, the image a Slack
 * message's image block points at: the marks of the report's first series,
 * with no text, as the report email draws it. 404 for a link of another kind
 * or a report without a trend.
 */
export default eventHandler(async (event) => {
  const opened = await openShareLink(event, { gonePage: false, image: true });
  if ('gone' in opened) return opened.gone;
  const report = await shareLinkReport(opened.db, opened.link);
  const trend = report ? emailTrendBlock(report.bundle) : null;
  if (!trend) throw apiError({ statusCode: 404, message: 'Not found' });
  const png = await chartPng(trend);
  setResponseHeader(event, 'Content-Type', 'image/png');
  setResponseHeader(event, 'Content-Length', String(png.length));
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Content-Security-Policy', "default-src 'none'");
  return png;
});
