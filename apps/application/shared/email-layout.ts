import { BRAND_MARK_CID, BRAND_SITE_LABEL, BRAND_SITE_URL, BRAND_VIOLET } from './brand';

/**
 * The frame every Piwi email shares: the header with the Piwi mark, the white
 * card, a banner in the message's tone atop it when it has one, and the footer
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
  /** The card's width in pixels on a wide screen; a phone gets its whole width. */
  width?: number;
  /** HTML drawn edge to edge atop the card: a notification's headline, in its outcome's color. */
  banner?: string;
}

/** The card's width when the frame names none. */
const DEFAULT_WIDTH = 560;

/**
 * The class of a block whose side padding shrinks on a phone, so the card's
 * content keeps the screen's width. The card's body and footer carry it.
 */
export const EMAIL_PAD_CLASS = 'piwi-pad';

/** The class of a framed block inside the card (a notification's failing test) whose padding shrinks on a phone. */
export const EMAIL_TIGHT_CLASS = 'piwi-tight';

/** An email's call to action, in the brand violet. */
export function emailButton(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background:${BRAND_VIOLET};color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">${label}</a>`;
}

/** The frame of an email in English: every email but a quality report in another language. */
export const ENGLISH_FRAME: EmailFrame = {
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
  const width = frame.width ?? DEFAULT_WIDTH;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(frame.lang)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>@media (max-width:600px){.${EMAIL_PAD_CLASS}{padding-left:16px!important;padding-right:16px!important}.${EMAIL_TIGHT_CLASS}{padding-left:12px!important;padding-right:12px!important}}</style></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr><td align="center">
      <table width="${width}" cellpadding="0" cellspacing="0" style="width:100%;max-width:${width}px;">
        <tr><td style="padding:0 4px 14px;">
          <img src="${markSrc}" width="17" height="20" alt="" style="vertical-align:-4px;border:0;">
          <span style="margin-left:6px;font-size:15px;font-weight:700;color:#0d1d47;">Piwi Dashboard</span>
        </td></tr>
      </table>
      <table width="${width}" cellpadding="0" cellspacing="0" style="width:100%;max-width:${width}px;background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden;">
        ${frame.banner ? `<tr><td>${frame.banner}</td></tr>` : ''}
        <tr><td class="${EMAIL_PAD_CLASS}" style="padding:28px 32px;">${body}</td></tr>
        <tr><td class="${EMAIL_PAD_CLASS}" style="padding:16px 32px;background:#f4f4f5;font-size:12px;color:#71717a;text-align:center;">
          ${escapeHtml(frame.automatedMessage)} <a href="${site}" style="color:#18181b;">${site}</a>
          <div style="margin-top:12px;padding-top:10px;border-top:1px solid #e4e4e7;font-size:11px;">
            <a href="${BRAND_SITE_URL}" style="color:#a1a1aa;text-decoration:none;">
              <img src="${markSrc}" width="10" height="12" alt="" style="vertical-align:-2px;border:0;opacity:.7;">
              ${escapeHtml(frame.sentBy)} · ${BRAND_SITE_LABEL}</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
