import { reportedRequestUrl } from '@piwitests/core/bug-report';
import { checkLocators, rankElement, type CheckedLocator } from './verified-locators.js';

/** What a part of the block is, for the panel to set it apart: the copy is the parts' text alone. */
export type ContextPartKind =
  | 'plain'
  | 'head'
  | 'label'
  | 'url'
  | 'tag'
  | 'attr'
  | 'string'
  | 'score'
  | 'locator'
  | 'note';

export interface ContextPart {
  kind: ContextPartKind;
  text: string;
}

/** A line of the block, as its parts. */
export type ContextLine = ContextPart[];

const part = (kind: ContextPartKind, text: string): ContextPart => ({ kind, text });

/** The block as the agent receives it: each line's parts, joined. */
export function contextText(lines: readonly ContextLine[]): string {
  return lines.map((line) => line.map((p) => p.text).join('')).join('\n');
}

/**
 * Bundles the page's address, a compact element summary, and every ranked
 * locator alternative into one paste-able block for an AI coding agent: its
 * lines as parts, which the panel sets apart and `contextText` joins.
 *
 * Addresses, the page's and a link's `href`, are written as a bug report
 * writes them (`reportedRequestUrl`): ids collapsed, query values removed,
 * no fragment, so a token in the address never reaches the agent.
 *
 * Not a Playwright `ariaSnapshot()` of the page: this summarizes just the
 * picked element itself — tag, role, the accessible name Playwright computes,
 * key attributes, text — and its locators as the Pick results check them
 * (`checkLocators`): the ones finding it alone first, then the others with how
 * many elements they find.
 *
 * Depends on generateAlternatives, tested via the real built bundle (see
 * agent-context-panel.ts), same as assertion-suggest.ts/lint-scan.ts.
 */
export function buildAgentContext(el: Element, pageUrl: string): ContextLine[] {
  function normalizeText(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }

  /** The page's address: its origin and route. */
  function pageAddress(url: string): string {
    const route = reportedRequestUrl(url, url);
    try {
      return route.startsWith('/') ? `${new URL(url).origin}${route}` : route;
    } catch {
      return route;
    }
  }

  /** An attribute's value; an address is reported as the page's is, a link to an id on the page kept as written. */
  function attributeValue(name: string, value: string): string {
    if (name !== 'href' || /^#[\w-]*$/.test(value)) return value;
    return reportedRequestUrl(value, pageUrl);
  }

  /** What the page says about a locator, for the agent: nothing for one finding the element alone. */
  function note(locator: CheckedLocator): ContextPart[] {
    switch (locator.verdict) {
      case 'narrowed':
        return [
          part('note', ' (narrowed from '),
          part('locator', locator.from!.locator),
          part('note', `, which finds ${locator.from!.count} elements)`),
        ];
      case 'position':
        return [
          part('note', ' (by position: '),
          part('locator', locator.from!.locator),
          part('note', ` finds ${locator.from!.count} elements)`),
        ];
      case 'ambiguous':
        return [part('note', ` (finds ${locator.count} elements on this page)`)];
      case 'unchecked':
        return [part('note', ' (not checked on this page)')];
      default:
        return [];
    }
  }

  const { attrs, accessibleName, role, ranked: candidates } = rankElement(el);
  const ranked = checkLocators(el, candidates, { keepAmbiguous: true });
  const text = normalizeText(el.textContent ?? '');

  const lines: ContextLine[] = [
    [part('head', '## Piwi element context')],
    [],
    [part('label', 'Page:'), part('plain', ' '), part('url', pageAddress(pageUrl))],
    [],
  ];

  const nameBits: ContextPart[][] = [];
  if (role) nameBits.push([part('plain', `role: ${role}`)]);
  if (accessibleName) nameBits.push([part('plain', 'accessible name: '), part('string', `"${accessibleName}"`)]);
  lines.push([
    part('label', 'Element:'),
    part('plain', ' '),
    part('tag', `<${attrs.tagName}>`),
    ...(nameBits.length > 0
      ? [part('plain', ' — '), ...nameBits.flatMap((bit, i) => (i > 0 ? [part('plain', ', '), ...bit] : bit))]
      : []),
  ]);

  const attributes = Object.entries(attrs.attributes).filter((entry): entry is [string, string] => entry[1] != null);
  if (attributes.length > 0) {
    lines.push([
      part('label', 'Attributes:'),
      ...attributes.flatMap(([k, v]) => [
        part('plain', ' '),
        part('attr', k),
        part('plain', '='),
        part('string', `"${attributeValue(k, v)}"`),
      ]),
    ]);
  }
  if (text) lines.push([part('label', 'Text:'), part('plain', ' '), part('string', `"${text}"`)]);

  lines.push([]);
  if (ranked.length > 0) {
    lines.push([part('label', 'Ranked locators (best first):')]);
    for (const [i, r] of ranked.entries()) {
      lines.push([
        part('note', `${i + 1}. `),
        part('score', `[${r.score}]`),
        part('plain', ' '),
        part('locator', r.locator),
        ...note(r),
      ]);
    }
  } else {
    lines.push([part('plain', 'No stable locator alternative could be generated for this element.')]);
  }

  return lines;
}
