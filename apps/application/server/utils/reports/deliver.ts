/**
 * The delivery of a `report.ready` outbox row: the snapshot's quality report
 * rendered for one channel. Email carries the trend as an inline PNG, Slack
 * gets blocks with a text sparkline, a webhook the signed bundle JSON, and a
 * browser a notification linking to the snapshot.
 */
import { loadSnapshotForDelivery } from '#shared/handlers/reports';
import { sparkline } from '#shared/reports/chart';
import { sentencesFor } from '#shared/reports/sentences';
import { reportWidgets, type ReportBundle } from '#shared/reports/types';
import { REPORT_READY_EVENT, type ReportReadyPayload } from '#shared/notification-events';
import type { DrizzleDB } from '#shared/handlers/db';
import { EMAIL_CHART, emailTrendBlock } from '#shared/reports/render-email';
import { isEmailConfigured, renderQualityReportEmail, sendEmail, type EmailAttachment } from '../email';
import { chartPng } from './chart-png';
import { runEventBus } from '../run-events';
import { slackEscape } from '../notifications/slack';

const siteBase = () => process.env.PIWI_SITE_URL?.replace(/\/$/, '') || 'http://localhost:3000';

/** Slack caps a section's fields at ten and its text at 3000 characters. */
const SLACK_FIELDS = 10;
const SLACK_TEXT_MAX = 2900;

export function snapshotUrl(snapshotId: number): string {
  return `${siteBase()}/reports/${snapshotId}`;
}

export async function loadReportForDelivery(
  db: DrizzleDB,
  payload: ReportReadyPayload,
): Promise<{ bundle: ReportBundle; projectIds: number[] }> {
  const snapshot = await loadSnapshotForDelivery(db, payload.snapshotId);
  if (!snapshot) throw new Error(`Report snapshot ${payload.snapshotId} no longer exists`);
  return snapshot;
}

export async function sendReportEmail(
  to: string,
  bundle: ReportBundle,
  payload: ReportReadyPayload,
  shareUrl: string | null = null,
): Promise<void> {
  if (!isEmailConfigured()) throw new Error('SMTP not configured');
  const trend = emailTrendBlock(bundle);
  const attachments: EmailAttachment[] = [];
  if (trend) {
    attachments.push({
      filename: 'trend.png',
      content: await chartPng(trend, EMAIL_CHART.width, EMAIL_CHART.height),
      contentType: 'image/png',
      cid: 'trend',
    });
  }
  const { subject, html, text } = renderQualityReportEmail(bundle, {
    url: snapshotUrl(payload.snapshotId),
    chartCid: trend ? 'trend' : null,
    shareUrl,
  });
  await sendEmail({ to, subject, html, text, attachments });
}

const clip = (text: string) => (text.length > SLACK_TEXT_MAX ? `${text.slice(0, SLACK_TEXT_MAX)}…` : text);

/**
 * Slack blocks: the verdict, the tiles as fields, the trend, the changes, a
 * button to the snapshot. With a share link the trend is an image block over
 * the link's `chart.png` (an incoming webhook cannot upload a file, and the
 * image needs a public address) and a second button opens the report without
 * an account; without one the trend is a text sparkline.
 */
export function reportSlackMessage(
  bundle: ReportBundle,
  url: string,
  shareUrl: string | null = null,
): Record<string, unknown> {
  const s = sentencesFor(bundle.language);
  const widgets = reportWidgets(bundle);
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(bundle.title).slice(0, 150), emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: clip(slackEscape(bundle.verdict.sentence)) } },
  ];
  const tiles = widgets.flatMap((w) => w.blocks).find((b) => b.kind === 'stats');
  if (tiles && tiles.kind === 'stats' && tiles.tiles.length > 0) {
    blocks.push({
      type: 'section',
      fields: tiles.tiles.slice(0, SLACK_FIELDS).map((t) => ({
        type: 'mrkdwn',
        text: `*${slackEscape(t.label)}*\n${slackEscape(t.value)}${t.change ? ` (${slackEscape(t.change)})` : ''}`,
      })),
    });
  }
  const trend = emailTrendBlock(bundle);
  const line = trend?.series[0];
  if (trend && line && shareUrl) {
    const summary = trend.summary ?? line.label;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackEscape(summary) } });
    blocks.push({ type: 'image', image_url: `${shareUrl}/chart.png`, alt_text: clip(summary).slice(0, 2000) });
  } else if (trend && line) {
    const spark = sparkline(line.points);
    if (spark) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${slackEscape(trend.summary ?? line.label)}\n\`${spark}\`` },
      });
    }
  }
  const changes = widgets.find((w) => w.type === 'insights')?.blocks.find((b) => b.kind === 'list');
  if (changes && changes.kind === 'list' && changes.items.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: clip(
          changes.items
            .slice(0, 6)
            .map((i) => `• ${slackEscape(i.text)}`)
            .join('\n'),
        ),
      },
    });
  }
  blocks.push(
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: s.labels.openInPiwi }, url },
        ...(shareUrl
          ? [{ type: 'button', text: { type: 'plain_text', text: s.labels.readWithoutAccount }, url: shareUrl }]
          : []),
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(bundle.period.label) }] },
  );
  return { text: `${s.labels.qualityReport}${s.colon}${slackEscape(bundle.title)}`, blocks };
}

/** The webhook body of a quality report: the event, its payload with the snapshot link (and share link), and the bundle. */
export function reportWebhookBody(
  bundle: ReportBundle,
  payload: ReportReadyPayload,
  shareUrl: string | null = null,
): string {
  const { shareToken: _sealed, ...fields } = payload;
  return JSON.stringify({
    event: REPORT_READY_EVENT,
    payload: { ...fields, url: snapshotUrl(payload.snapshotId), ...(shareUrl ? { shareUrl } : {}) },
    bundle,
    timestamp: new Date().toISOString(),
  });
}

/**
 * A browser notification that the report is ready: to the channel's owner
 * for a personal channel, else to everyone who can open every project the
 * report covers (the stream checks `projectIds`).
 */
export function publishReportNotification(
  bundle: ReportBundle,
  payload: ReportReadyPayload,
  channelUserId: number | null,
  projectIds: number[],
): void {
  runEventBus.publishNotification({
    type: REPORT_READY_EVENT,
    snapshotId: payload.snapshotId,
    scheduleId: payload.scheduleId,
    title: bundle.title,
    projectIds,
    ...(channelUserId != null ? { targetUserId: channelUserId } : {}),
  });
}
