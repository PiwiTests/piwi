/**
 * Pieces of the HTML a page copies with `useCopyRich`, which a rich-text editor
 * (Slack, Jira, Notion, Google Docs) pastes as markup. Every value is escaped,
 * and a link is live only for an http(s) URL.
 */
import { escapeHtml } from '#shared/markdown-to-html';
import { safeHttpUrl } from '#shared/utils/safe-url';

/** `text` linked to `href` when it is an http(s) URL, else `text` alone; both escaped. */
export function richCopyLink(href: string | null | undefined, text: string): string {
  const url = safeHttpUrl(href);
  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>` : escapeHtml(text);
}

/** The "Tracked in" paragraph: the issue's key linked to the issue, then its status. */
export function trackedIssueHtml(issue: { key: string; url: string; status?: string | null }): string {
  const status = issue.status ? ` (${escapeHtml(issue.status)})` : '';
  return `<p>Tracked in ${richCopyLink(issue.url, issue.key)}${status}</p>`;
}
