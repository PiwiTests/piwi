import { BRAND_MARK_CID, BRAND_SITE_LABEL, BRAND_SITE_URL, BRAND_VIOLET } from './brand';

/**
 * The frame every Piwi email shares: the header with the Piwi mark, the white
 * card, a stripe in the message's tone above it when it has one, and the footer
 * naming the instance, then the mark again with a link to the project's site.
 * Pure, so the schedule form can show a quality report email exactly as the
 * server sends it.
 */

/** Escape user-controlled text (test titles, error messages) for HTML emails. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The language of an email: its `lang` attribute and the footer's two lines. */
export interface EmailFrame {
  lang: string;
  /** Before the instance's address. */
  automatedMessage: string;
  /** The credit beside the Piwi mark. */
  sentBy: string;
  /** The mark's image: the attachment's `cid:…` when sent (the default), a data address in a preview. */
  markSrc?: string;
  /** The color of the stripe atop the card: the message's outcome (a failure, a fix); none for a neutral message. */
  accent?: string;
}

/** An email's call to action, in the brand violet. */
export function emailButton(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background:${BRAND_VIOLET};color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">${label}</a>`;
}

const ENGLISH_FRAME: EmailFrame = {
  lang: 'en',
  automatedMessage: 'This is an automated message from',
  sentBy: 'Sent by Piwi',
};

/**
 * An email document: `title` (already escaped) in its head, `body` in the
 * card, `siteUrl` in the footer. A quality report email is framed in its
 * report's language; the other emails in English.
 */
export function emailLayout(title: string, body: string, siteUrl: string, frame: EmailFrame = ENGLISH_FRAME): string {
  const site = escapeHtml(siteUrl);
  const markSrc = escapeHtml(frame.markSrc ?? `cid:${BRAND_MARK_CID}`);
  const stripe = frame.accent
    ? `<tr><td height="4" style="height:4px;line-height:4px;font-size:1px;background:${escapeHtml(frame.accent)};">&nbsp;</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(frame.lang)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
        <tr><td style="padding:0 4px 14px;">
          <img src="${markSrc}" width="17" height="20" alt="" style="vertical-align:-4px;border:0;">
          <span style="margin-left:6px;font-size:15px;font-weight:700;color:#0d1d47;">Piwi Dashboard</span>
        </td></tr>
      </table>
      <table width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden;">
        ${stripe}
        <tr><td style="padding:28px 32px;">${body}</td></tr>
        <tr><td style="padding:16px 32px;background:#f4f4f5;font-size:12px;color:#71717a;text-align:center;">
          ${escapeHtml(frame.automatedMessage)} <a href="${site}" style="color:#18181b;">${site}</a>
          <br><a href="${BRAND_SITE_URL}" style="display:inline-block;margin-top:8px;color:#71717a;text-decoration:none;">
            <img src="${markSrc}" width="12" height="14" alt="" style="vertical-align:-2px;border:0;">
            ${escapeHtml(frame.sentBy)} · ${BRAND_SITE_LABEL}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
