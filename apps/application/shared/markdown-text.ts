/**
 * Text Piwi did not write (a test's title, an error, a name a project chose),
 * placed in Markdown that a code host or a tracker renders: a pull-request
 * comment, an issue, a report.
 */

/** The characters with a meaning in Markdown, HTML or a code host's references, escaped with a backslash. */
const SYNTAX = /[\\`*_[\]<>|~#!&$%]/g;

/**
 * `text` with a zero-width space after the `@` of a mention, the `#` of an issue
 * number, the scheme of a URL and a leading `www`, so a code host neither links
 * nor notifies through it. Invisible to the reader.
 */
export function withoutReferences(text: string): string {
  return text
    .replace(/@(?=[\w-])/g, '@\u200B')
    .replace(/#(?=\d)/g, '#\u200B')
    .replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, '$1:\u200B//')
    .replace(/\bwww\./gi, (www) => `${www.slice(0, 3)}\u200B.`);
}

/**
 * `text` on one line, as inline Markdown a code host renders as written: every
 * character with a meaning in Markdown, HTML or a code host's references is
 * escaped, and its references are cut (`withoutReferences`), so the text never
 * formats, links or notifies anyone. For Markdown only ever read rendered: each
 * escape shows where the Markdown is read as it is.
 */
export function literalMarkdown(text: string): string {
  return withoutReferences(text.replace(/\r\n|\r|\n/g, ' ').replace(SYNTAX, '\\$&'));
}

/** A link's destination, its parentheses, angle brackets and white space encoded, so the text after it stays text. */
export function markdownLinkTarget(url: string): string {
  return url.replace(/[()<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}
