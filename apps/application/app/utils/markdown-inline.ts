import { assistantEntityKey, assistantEntityRoute, parseAssistantLink } from '#shared/assistant';
import { isSafeLinkTarget } from '#shared/utils/safe-url';

function escapeMarkdownText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A link inside a sentence: the sentence's color, a dotted underline. */
const PROSE_LINK_CLASS = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';

/**
 * How `[label](piwi:<type>/<id>)` entity links render: as a link to the
 * entity's page when it is one of `known` (`assistantEntityKey` values), else
 * as its label alone.
 */
export interface EntityLinkOptions {
  known: ReadonlySet<string>;
  /** The app's base URL, put before the entity's route in the link's `href`. */
  baseURL: string;
}

/** `route` (from the app's root) under `baseURL`. */
function withBase(baseURL: string, route: string): string {
  return `${baseURL.replace(/\/+$/, '')}${route}`;
}

/**
 * Render a Markdown line's inline `code`, **bold** and [links] to safe HTML for
 * `MarkdownPreview`. Escapes first; a link whose target is not http(s), mailto
 * or same-site stays text. With `entities`, a `piwi:` entity link renders as a
 * link carrying its route in `data-route` (the preview routes a plain click in
 * the app) when the entity is known, and as its label otherwise, and every link
 * keeps the sentence's color.
 */
export function inlineMarkdownHtml(raw: string, entities?: EntityLinkOptions): string {
  let h = escapeMarkdownText(raw);
  h = h.replace(/`([^`]+)`/g, '<code class="rounded bg-gray-200 dark:bg-gray-700 px-1 py-px">$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100">$1</strong>');
  const linkClass = entities ? PROSE_LINK_CLASS : 'text-primary hover:underline';
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text: string, href: string) => {
    const entity = entities ? parseAssistantLink(href) : null;
    if (entities && entity) {
      if (!entities.known.has(assistantEntityKey(entity))) return text;
      const route = assistantEntityRoute(entity);
      return `<a href="${withBase(entities.baseURL, route)}" data-route="${route}" class="${linkClass}">${text}</a>`;
    }
    return isSafeLinkTarget(href) && !/[<>"\s]/.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener" class="${linkClass}">${text}</a>`
      : match;
  });
  return h;
}
