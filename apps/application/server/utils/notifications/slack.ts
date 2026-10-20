/**
 * Slack mrkdwn escaping. Slack reads `<…>` as a link, a mention (`<!channel>`)
 * or a user reference, so every value a message interpolates (test titles,
 * branches, error excerpts, project names, links) goes through these helpers.
 */

/** Escape `&`, `<` and `>`, the three characters Slack decodes in mrkdwn text. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A `<url|label>` link with both parts escaped; a `|` in the URL is percent-encoded so it cannot end the URL. */
export function slackLink(url: string, label: string): string {
  return `<${slackEscape(url).replace(/\|/g, '%7C')}|${slackEscape(label)}>`;
}
