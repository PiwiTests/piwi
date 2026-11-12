/**
 * The prefix a project puts at the start of every ticket title Piwi files
 * (`[Piwi]`, `QA:`), so a tracker's own filters and boards can tell Piwi's
 * issues apart. Pure: the builders in `./build-issue` and `./run-issue` apply
 * it, and every caller resolves it the way it resolves the ticket language.
 */

/** The longest prefix a binding or a connection may set. */
export const TITLE_PREFIX_MAX_LENGTH = 40;

/** The longest title a tracker takes; the prefix counts toward it. */
export const TICKET_TITLE_MAX_LENGTH = 255;

/** The first `max` UTF-16 units of `text`, never ending between the halves of a surrogate pair. */
function headOf(text: string, max: number): string {
  let end = Math.max(0, Math.min(max, text.length));
  const last = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** A line cut to `max` characters, ending in an ellipsis when it was longer. */
export function cutLine(line: string, max: number): string {
  return line.length <= max ? line : `${headOf(line, max - 1).trimEnd()}…`;
}

/** A prefix as stored: one line, at most {@link TITLE_PREFIX_MAX_LENGTH} characters, or null when nothing is left. */
export function normalizeTitlePrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = headOf(value.replace(/\s+/g, ' ').trim(), TITLE_PREFIX_MAX_LENGTH).trim();
  return line || null;
}

/** The prefix a project uses: its own, else its connection's default, else none. */
export function resolveTitlePrefix(bindingPrefix: string | null | undefined, connectionConfig: unknown): string | null {
  const own = normalizeTitlePrefix(bindingPrefix);
  if (own) return own;
  const config = (connectionConfig ?? null) as { titlePrefix?: unknown } | null;
  return normalizeTitlePrefix(config?.titlePrefix);
}

/**
 * `title` behind `prefix`, within `max` characters: the title is cut, never the
 * prefix. The title is read as one line first, and one that is the prefix or
 * starts with it and a space, in any letter case, is not prefixed again. Any
 * title when there is no prefix comes back as it is.
 */
export function prefixedTitle(
  prefix: string | null | undefined,
  title: string,
  max: number = TICKET_TITLE_MAX_LENGTH,
): string {
  const lead = normalizeTitlePrefix(prefix);
  if (!lead) return title;
  const line = title.replace(/\s+/g, ' ').trim();
  const folded = line.toLowerCase();
  const head = lead.toLowerCase();
  if (folded === head || folded.startsWith(`${head} `)) return cutLine(line, max);
  return `${lead} ${cutLine(line, max - lead.length - 1)}`;
}
