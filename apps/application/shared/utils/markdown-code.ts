/**
 * `text` as a Markdown code span that holds any backtick it contains: its fence is one backtick longer than the longest
 * run inside, and padded with a space when the text starts or ends with a backtick (CommonMark strips one each side).
 */
export function markdownCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
