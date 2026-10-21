import type { Transporter } from 'nodemailer';
import { STATUS_COLORS } from '#shared/status-colors';
import {
  clusterOutcome,
  renderEventSubject,
  notificationTargetPath,
  failureTargetPath,
} from '#shared/notification-events';
import type {
  ClusterFixedPayload,
  ClusterNewPayload,
  ClusterRegressedPayload,
  EnvironmentIncidentPayload,
  NotificationEvent,
  NotificationPayload,
  RunFinishedPayload,
  TopFailure,
} from '#shared/notification-events';
import type { ReportBundle } from '#shared/reports/types';
import { renderReportEmail } from '#shared/reports/render-email';
import { emailLayout as layoutEmail, escapeHtml } from '#shared/email-layout';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  from: string;
  fromName: string;
  hasPassword: boolean;
  secure: boolean;
  configured: boolean;
  envManaged: true;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Content id: an inline image the HTML shows as `<img src="cid:…">`. */
  cid?: string;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

let _transport: Transporter | null = null;
let _warnedMissingSiteUrl = false;

export function getSmtpConfig(): SmtpConfig {
  const host = process.env.PIWI_SMTP_HOST || '';
  const user = process.env.PIWI_SMTP_USER || '';
  const pass = process.env.PIWI_SMTP_PASS || '';
  const from = process.env.PIWI_SMTP_FROM || '';
  const fromName = process.env.PIWI_SMTP_FROM_NAME || 'Piwi Dashboard';
  const port = parseInt(process.env.PIWI_SMTP_PORT || '587', 10);
  // Default secure to true only for port 465; explicit PIWI_SMTP_SECURE overrides
  const secureDefault = port === 465;
  const secure =
    process.env.PIWI_SMTP_SECURE === 'true' || (process.env.PIWI_SMTP_SECURE === undefined && secureDefault);
  // Credentials are optional — a relay that accepts unauthenticated mail only
  // needs host + from.
  const configured = Boolean(host && from);

  return { host, port, user, from, fromName, hasPassword: Boolean(pass), secure, configured, envManaged: true };
}

export function isEmailConfigured(): boolean {
  return getSmtpConfig().configured;
}

async function getTransport(): Promise<Transporter> {
  if (_transport) return _transport;
  const cfg = getSmtpConfig();
  const pass = process.env.PIWI_SMTP_PASS || '';
  const { default: nodemailer } = await import('nodemailer');
  _transport ??= nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // Only authenticate when credentials are set; an auth block with empty
    // values would make nodemailer attempt AUTH against auth-less relays.
    ...(cfg.user && pass ? { auth: { user: cfg.user, pass } } : {}),
  });
  return _transport;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const cfg = getSmtpConfig();
  if (!cfg.configured) {
    console.warn('[email] SMTP not configured — skipping send to', opts.to);
    return;
  }
  if (!process.env.PIWI_SITE_URL && !_warnedMissingSiteUrl) {
    _warnedMissingSiteUrl = true;
    console.warn(
      '[email] PIWI_SITE_URL is not set — links in outgoing emails will point at http://localhost:3000. ' +
        'Set PIWI_SITE_URL to the public URL of this dashboard.',
    );
  }
  const transport = await getTransport();
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.from}>` : cfg.from;
  await transport.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
  });
  console.info('[email] Sent "%s" to %s', opts.subject, opts.to);
}

// ── Email templates ───────────────────────────────────────────────────────────

const siteUrl = () => process.env.PIWI_SITE_URL?.replace(/\/$/, '') || 'http://localhost:3000';

/** Passed and failed text colors: the dashboard's outcome colors, as in the HTML export. */
const PASSED_COLOR = STATUS_COLORS.passed.text;
const FAILED_COLOR = STATUS_COLORS.failed.text;

function emailLayout(title: string, body: string): { html: string; text: string } {
  return { html: layoutEmail(escapeHtml(title), body, siteUrl()), text: title };
}

export function renderPasswordResetEmail(token: string): { html: string; text: string } {
  const url = `${siteUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">Reset your password</h2>
    <p style="margin:0 0 24px;color:#52525b;">Click the button below to reset your password. This link expires in 1 hour.</p>
    <a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">If you didn't request this, ignore this email — your account is safe.</p>
    <p style="margin:8px 0 0;font-size:12px;color:#a1a1aa;">Link: <a href="${url}" style="color:#18181b;">${url}</a></p>`;
  const { html } = emailLayout('Reset your password', body);
  const text = `Reset your password\n\nClick the link below to reset your password. This link expires in 1 hour.\n\n${url}\n\nIf you didn't request this, ignore this email.`;
  return { html, text };
}

export function renderInviteEmail(token: string, invitedBy?: string): { html: string; text: string } {
  const url = `${siteUrl()}/reset-password?token=${encodeURIComponent(token)}&mode=invite`;
  const byLine = invitedBy
    ? `<p style="margin:0 0 24px;color:#52525b;">You were invited by <strong>${escapeHtml(invitedBy)}</strong>. Click the button below to set your password and activate your account. This link expires in 72 hours.</p>`
    : `<p style="margin:0 0 24px;color:#52525b;">Click the button below to set your password and activate your account. This link expires in 72 hours.</p>`;
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">You've been invited to Piwi Dashboard</h2>
    ${byLine}
    <a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Set password &amp; activate</a>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">Link: <a href="${url}" style="color:#18181b;">${url}</a></p>`;
  const { html } = emailLayout("You've been invited to Piwi Dashboard", body);
  const text = `You've been invited to Piwi Dashboard\n\nClick the link below to set your password and activate your account. This link expires in 72 hours.\n\n${url}`;
  return { html, text };
}

export function renderVerifyEmail(token: string): { html: string; text: string } {
  const url = `${siteUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">Verify your email</h2>
    <p style="margin:0 0 24px;color:#52525b;">Click the button below to verify your email address.</p>
    <a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Verify email</a>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">Link: <a href="${url}" style="color:#18181b;">${url}</a></p>`;
  const { html } = emailLayout('Verify your email', body);
  const text = `Verify your email\n\nClick the link below to verify your email address.\n\n${url}`;
  return { html, text };
}

export function renderTestEmail(to: string): { html: string; text: string } {
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">Test email</h2>
    <p style="margin:0 0 8px;color:#52525b;">This is a test email from Piwi Dashboard. If you received this, SMTP is configured correctly.</p>
    <p style="margin:0;color:#a1a1aa;font-size:12px;">Sent to: ${escapeHtml(to)}</p>`;
  const { html } = emailLayout('Test email — Piwi Dashboard', body);
  const text = `Test email from Piwi Dashboard. SMTP is configured correctly. Sent to: ${to}`;
  return { html, text };
}

/** Where a failing test links to: its execution, else its history, else the run. */
function failureUrl(failure: TopFailure, runUrl: string): string {
  const path = failureTargetPath(failure);
  return path ? `${siteUrl()}${path}` : runUrl;
}

export function renderRunNotificationEmail(opts: {
  projectName: string;
  runId: number;
  status: string;
  totalTests: number;
  failedTests: number;
  branch?: string;
  topFailures?: TopFailure[];
}): { html: string; text: string } {
  const url = `${siteUrl()}/test-runs/${opts.runId}`;
  const statusColor = opts.status === 'passed' ? PASSED_COLOR : FAILED_COLOR;

  const failures = opts.topFailures ?? [];
  let failuresHtml = '';
  let failuresText = '';
  if (failures.length > 0) {
    const rows = failures
      .map((f) => {
        const caseUrl = failureUrl(f, url);
        const title = escapeHtml(f.title);
        const titleHtml = `<a href="${caseUrl}" style="color:#18181b;font-weight:600;text-decoration:none;">${title}</a>`;
        const loc = f.filePath ? `<div style="color:#a1a1aa;font-size:12px;">${escapeHtml(f.filePath)}</div>` : '';
        const headline = f.headline
          ? `<div style="margin-top:4px;color:#18181b;font-size:14px;">${escapeHtml(f.headline)}</div>`
          : '';
        const excerpt = f.errorExcerpt
          ? `<pre style="margin:6px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#52525b;background:#fafafa;padding:8px;border-radius:4px;">${escapeHtml(f.errorExcerpt)}</pre>`
          : '';
        return `<li style="margin-bottom:12px;list-style:none;">${titleHtml}${loc}${headline}${excerpt}</li>`;
      })
      .join('');
    failuresHtml = `<ul style="margin:0 0 24px;padding:0;">${rows}</ul>`;
    failuresText = failures
      .map((f) => {
        const caseUrl = failureUrl(f, url);
        const loc = f.filePath ? ` (${f.filePath})` : '';
        const headline = f.headline ? `\n  ${f.headline}` : '';
        const excerpt = f.errorExcerpt ? `\n    ${f.errorExcerpt.replace(/\n/g, '\n    ')}` : '';
        return `- ${f.title}${loc}${headline}\n  ${caseUrl}${excerpt}`;
      })
      .join('\n');
  }

  const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#18181b;">Test run ${escapeHtml(opts.status)}</h2>
    <p style="margin:0 0 24px;color:#52525b;font-size:14px;">${escapeHtml(opts.projectName)}${opts.branch ? ` · ${escapeHtml(opts.branch)}` : ''}</p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:8px 16px;background:#f4f4f5;border-radius:6px;font-size:14px;">
          Status: <strong style="color:${statusColor};">${escapeHtml(opts.status)}</strong>
          &nbsp;·&nbsp; ${opts.totalTests} tests
          ${opts.failedTests > 0 ? `&nbsp;·&nbsp; <strong style="color:${FAILED_COLOR};">${opts.failedTests} failed</strong>` : ''}
        </td>
      </tr>
    </table>
    ${failuresHtml}
    <a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">View run</a>`;
  const { html } = emailLayout(`Test run ${opts.status} — ${opts.projectName}`, body);
  const text = `Test run ${opts.status}: ${opts.projectName}${opts.branch ? ` (${opts.branch})` : ''}\n${opts.totalTests} tests${opts.failedTests > 0 ? `, ${opts.failedTests} failed` : ''}${failuresText ? `\n\n${failuresText}` : ''}\n\nView run: ${url}`;
  return { html, text };
}

/** A failure cluster's title (when it adds something) above its signature. */
function clusterIdentityHtml(signature: string, title?: string | null): string {
  const heading =
    title && title !== signature
      ? `<p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#18181b;">${escapeHtml(title)}</p>`
      : '';
  return `${heading}<p style="margin:0 0 16px;font-family:monospace;font-size:13px;background:#f4f4f5;padding:12px;border-radius:6px;overflow:auto;">${escapeHtml(signature)}</p>`;
}

function clusterIdentityText(signature: string, title?: string | null): string {
  return `${title && title !== signature ? `${title}\n` : ''}${signature}`;
}

/** The tracker issue a cluster is known by. */
function trackedInHtml(knownIssue?: { key: string; url: string }): string {
  return knownIssue
    ? `<p style="margin:0 0 16px;color:#52525b;font-size:13px;">Tracked in <a href="${escapeHtml(knownIssue.url)}" style="color:#18181b;font-weight:600;">${escapeHtml(knownIssue.key)}</a></p>`
    : '';
}

function trackedInText(knownIssue?: { key: string; url: string }): string {
  return knownIssue ? `\n\nTracked in ${knownIssue.key}: ${knownIssue.url}` : '';
}

function viewClusterButton(url: string): string {
  return `<a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">View cluster</a>`;
}

export function renderNewClusterEmail(opts: {
  projectName: string;
  clusterId: number;
  signature: string;
  /** Display name shown above the signature when it adds something. */
  title?: string | null;
  sampleErrorExcerpt?: string;
  affectedCases?: number;
  /** The tracker issue the cluster is known by, named when set. */
  knownIssue?: { key: string; url: string };
}): {
  html: string;
  text: string;
} {
  const url = `${siteUrl()}/failure-clusters/${opts.clusterId}`;
  const affected =
    opts.affectedCases && opts.affectedCases > 0
      ? `<p style="margin:0 0 16px;color:#52525b;font-size:13px;">${opts.affectedCases} affected test${opts.affectedCases === 1 ? '' : 's'} in this run</p>`
      : '';
  const excerpt = opts.sampleErrorExcerpt
    ? `<pre style="margin:0 0 24px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#52525b;background:#fafafa;padding:12px;border-radius:6px;">${escapeHtml(opts.sampleErrorExcerpt)}</pre>`
    : '';
  const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#18181b;">New failure cluster</h2>
    <p style="margin:0 0 24px;color:#52525b;font-size:14px;">${escapeHtml(opts.projectName)}</p>
    ${clusterIdentityHtml(opts.signature, opts.title)}
    ${affected}
    ${excerpt}
    ${trackedInHtml(opts.knownIssue)}
    ${viewClusterButton(url)}`;
  const { html } = emailLayout(`New failure cluster — ${opts.projectName}`, body);
  const text = `New failure cluster in ${opts.projectName}${opts.affectedCases ? ` (${opts.affectedCases} affected)` : ''}\n\n${clusterIdentityText(opts.signature, opts.title)}${opts.sampleErrorExcerpt ? `\n\n${opts.sampleErrorExcerpt}` : ''}${trackedInText(opts.knownIssue)}\n\nView: ${url}`;
  return { html, text };
}

/** The email for a `cluster.fixed` or `cluster.regressed` verdict: the cluster, what changed in triage, its tracker issue and a link. */
export function renderClusterOutcomeEmail(opts: {
  /** The verdict's headline, as in the subject line. */
  headline: string;
  projectName: string;
  clusterId: number;
  signature: string;
  title?: string | null;
  /** The triage change the verdict made, named when set. */
  triageNote?: string | null;
  knownIssue?: { key: string; url: string };
}): { html: string; text: string } {
  const url = `${siteUrl()}/failure-clusters/${opts.clusterId}`;
  const triage = opts.triageNote
    ? `<p style="margin:0 0 16px;color:#52525b;font-size:13px;">${escapeHtml(opts.triageNote)}</p>`
    : '';
  const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#18181b;">${escapeHtml(opts.headline)}</h2>
    <p style="margin:0 0 24px;color:#52525b;font-size:14px;">${escapeHtml(opts.projectName)}</p>
    ${clusterIdentityHtml(opts.signature, opts.title)}
    ${triage}
    ${trackedInHtml(opts.knownIssue)}
    ${viewClusterButton(url)}`;
  const { html } = emailLayout(`${opts.headline} — ${opts.projectName}`, body);
  const text = `${opts.headline} in ${opts.projectName}\n\n${clusterIdentityText(opts.signature, opts.title)}${opts.triageNote ? `\n\n${opts.triageNote}` : ''}${trackedInText(opts.knownIssue)}\n\nView: ${url}`;
  return { html, text };
}

/** The email for one notification event: its own template where it has one, else the subject line. */
export function renderNotificationEmail(
  event: NotificationEvent,
  payload: NotificationPayload,
): { html: string; text: string } {
  if (event.startsWith('run.')) {
    const p = payload as RunFinishedPayload;
    return renderRunNotificationEmail({
      projectName: p.projectName,
      runId: p.runId,
      status: p.status,
      totalTests: p.totalTests,
      failedTests: p.failedTests,
      branch: p.branch,
      topFailures: p.topFailures,
    });
  }
  if (event === 'cluster.new') {
    const p = payload as ClusterNewPayload;
    return renderNewClusterEmail({
      projectName: p.projectName,
      clusterId: p.clusterId,
      signature: p.signature,
      title: p.title,
      sampleErrorExcerpt: p.sampleErrorExcerpt,
      affectedCases: p.affectedCases,
      knownIssue: p.knownIssue,
    });
  }
  if (event === 'cluster.fixed' || event === 'cluster.regressed') {
    const p = payload as ClusterFixedPayload | ClusterRegressedPayload;
    const { headline, triageNote } = clusterOutcome(event, p);
    return renderClusterOutcomeEmail({
      headline,
      projectName: p.projectName,
      clusterId: p.clusterId,
      signature: p.signature,
      title: p.title,
      triageNote,
      knownIssue: p.knownIssue,
    });
  }
  const subject = renderEventSubject(event, payload);
  if (event === 'environment.incident') {
    const p = payload as EnvironmentIncidentPayload;
    const url = `${siteUrl()}/test-runs/${p.runId}`;
    const note = 'Left out of flaky scores, baselines, fix verification and the gate (inconclusive).';
    const body = `
    <h2 style="margin:0 0 8px;font-size:20px;color:#18181b;">${escapeHtml(subject)}</h2>
    <p style="margin:0 0 16px;color:#18181b;font-size:14px;">${escapeHtml(p.reason)}</p>
    <p style="margin:0 0 24px;color:#52525b;font-size:13px;">${escapeHtml(note)}</p>
    <a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">View run</a>`;
    const { html } = emailLayout(subject, body);
    return { html, text: `${subject}\n\n${p.reason}\n${note}\n\nView: ${url}` };
  }
  return { html: `<p>${escapeHtml(subject)}</p>`, text: subject };
}

/** One event queued for a digest send. */
export interface DigestItem {
  event: NotificationEvent;
  payload: NotificationPayload;
}

/**
 * One email summarizing every notification a digest-mode subscription batched
 * since the previous send: subject line + link per item, with run stats where
 * the payload carries them.
 */
export function renderDigestEmail(items: DigestItem[]): { subject: string; html: string; text: string } {
  const subject = `Piwi digest — ${items.length} notification${items.length === 1 ? '' : 's'}`;

  const rows = items
    .map(({ event, payload }) => {
      const line = renderEventSubject(event, payload);
      const path = notificationTargetPath(event, payload);
      const url = path ? `${siteUrl()}${path}` : null;
      const run = payload as RunFinishedPayload;
      const stats =
        event.startsWith('run.') && run.totalTests != null
          ? `<div style="color:#71717a;font-size:12px;">${run.totalTests} tests${run.failedTests ? ` · <span style="color:${FAILED_COLOR};">${run.failedTests} failed</span>` : ''}</div>`
          : '';
      const title = url
        ? `<a href="${url}" style="color:#18181b;font-weight:600;text-decoration:none;">${escapeHtml(line)}</a>`
        : `<span style="font-weight:600;">${escapeHtml(line)}</span>`;
      return `<li style="margin-bottom:12px;list-style:none;">${title}${stats}</li>`;
    })
    .join('');

  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">Your notification digest</h2>
    <ul style="margin:0;padding:0;">${rows}</ul>`;
  const { html } = emailLayout(subject, body);

  const text = items
    .map(({ event, payload }) => {
      const path = notificationTargetPath(event, payload);
      return `- ${renderEventSubject(event, payload)}${path ? `\n  ${siteUrl()}${path}` : ''}`;
    })
    .join('\n');
  return { subject, html, text: `${subject}\n\n${text}` };
}

// ── Quality report ────────────────────────────────────────────────────────────

/** The quality report email as sent: the chart attached by content id, the footer naming this instance. */
export function renderQualityReportEmail(
  bundle: ReportBundle,
  opts: { url: string; chartCid: string | null; shareUrl?: string | null },
): { subject: string; html: string; text: string } {
  return renderReportEmail(bundle, {
    url: opts.url,
    chartSrc: opts.chartCid ? `cid:${opts.chartCid}` : null,
    shareUrl: opts.shareUrl,
    siteUrl: siteUrl(),
  });
}
