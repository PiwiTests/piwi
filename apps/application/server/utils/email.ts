import type { Transporter } from 'nodemailer';
import type { ReportBundle } from '#shared/reports/types';
import { renderReportEmail } from '#shared/reports/render-email';
import { emailButton, emailLayout as layoutEmail, escapeHtml } from '#shared/email-layout';
import { BRAND_MARK_CID, piwiMarkPng } from '#shared/brand';
import type { NotificationEvent, NotificationPayload } from '#shared/notification-events';
import {
  renderDigestEmailAt,
  renderNotificationEmailAt,
  type DigestItem,
  type RenderedEmail,
} from '#shared/notifications/render-email';

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
  // The footer's Piwi mark travels with the message, so no image is fetched when it is read.
  const attachments = [...(opts.attachments ?? [])];
  if (opts.html.includes(`cid:${BRAND_MARK_CID}`) && !attachments.some((a) => a.cid === BRAND_MARK_CID)) {
    attachments.push({
      filename: 'piwi.png',
      content: Buffer.from(piwiMarkPng()),
      contentType: 'image/png',
      cid: BRAND_MARK_CID,
    });
  }
  await transport.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(attachments.length ? { attachments } : {}),
  });
  console.info('[email] Sent "%s" to %s', opts.subject, opts.to);
}

// ── Email templates ───────────────────────────────────────────────────────────

/** The dashboard's public address, which every link in an email starts with. */
const siteUrl = () => process.env.PIWI_SITE_URL?.replace(/\/$/, '') || 'http://localhost:3000';

function emailLayout(title: string, body: string): { html: string; text: string } {
  return { html: layoutEmail(escapeHtml(title), body, siteUrl()), text: title };
}

export function renderPasswordResetEmail(token: string): { html: string; text: string } {
  const url = `${siteUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">Reset your password</h2>
    <p style="margin:0 0 24px;color:#52525b;">Click the button below to reset your password. This link expires in 1 hour.</p>
    ${emailButton(url, 'Reset password')}
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
    ${emailButton(url, 'Set password &amp; activate')}
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
    ${emailButton(url, 'Verify email')}
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

/** The email for one notification event, its links on this instance. */
export function renderNotificationEmail(event: NotificationEvent, payload: NotificationPayload): RenderedEmail {
  return renderNotificationEmailAt(event, payload, siteUrl());
}

/** One email for every notification a digest-mode subscription batched since the previous send. */
export function renderDigestEmail(items: DigestItem[]): RenderedEmail & { subject: string } {
  return renderDigestEmailAt(items, siteUrl());
}

export type { DigestItem };

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
