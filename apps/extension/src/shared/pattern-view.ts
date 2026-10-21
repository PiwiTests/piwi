import { urlParts } from './step-view.js';

/**
 * A URL pattern (`https://shop.example/**`, `**\/api/cart?_=*`), or the address
 * of a site the extension talks to, as the settings and DevTools show it: the
 * scheme and the query dimmed, the host in front, the path after it, and each
 * wildcard set apart from the characters around it. It takes `STEP_CSS` and
 * {@link PATTERN_CSS}.
 */
export function patternView(pattern: string): HTMLElement {
  const view = document.createElement('span');
  view.className = 'piwi-url piwi-pattern';
  view.title = pattern;
  const { origin, path, rest } = urlParts(pattern);
  const scheme = /^[a-z][\w+.-]*:\/\//i.exec(origin)?.[0] ?? '';
  for (const [text, className] of [
    [scheme, 'piwi-url-rest'],
    [origin.slice(scheme.length), 'piwi-pattern-host'],
    [path, 'piwi-pattern-path'],
    [rest, 'piwi-url-rest'],
  ] as const) {
    if (!text) continue;
    const part = document.createElement('span');
    part.className = className;
    part.append(...wildcards(text));
    view.append(part);
  }
  return view;
}

/** `text` with each `*` and `**` in a span of its own. */
function wildcards(text: string): Node[] {
  return text
    .split(/(\*\*?)/)
    .filter(Boolean)
    .map((piece) => {
      if (!piece.startsWith('*')) return document.createTextNode(piece);
      const wild = document.createElement('span');
      wild.className = 'piwi-wild';
      wild.textContent = piece;
      return wild;
    });
}

/** The look of a pattern's host, path and wildcards, on top of `STEP_CSS`'s addresses. */
export const PATTERN_CSS = `
  .piwi-pattern-host { color: var(--piwi-name); font-weight: 600; }
  .piwi-pattern-path { color: var(--piwi-url-path); }
  .piwi-wild {
    color: var(--piwi-act); font-weight: 700; padding: 0 1px; border-radius: 3px;
    background: color-mix(in srgb, var(--piwi-act) 16%, transparent);
  }
`;
