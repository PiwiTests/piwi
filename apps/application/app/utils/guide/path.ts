/**
 * The line at the top of a guide's popover saying where its stop is: the
 * page's breadcrumb, then the tab and the sections the stop sits in, each
 * segment the guide opened on its way there marked. Also how a control on the
 * screen leads to the route a stop opens, so the guide points at it first.
 */

/** The most segments the line shows; the first ones fold into `…` past it. */
const MAX_PATH_SEGMENTS = 4;
/** The longest a segment's label gets before it ends with `…`. */
const MAX_LABEL_CHARS = 40;
/** The breadcrumb's root, which every page shares, so the line leaves it out when more follows. */
const ROOT_CRUMB = 'Home';

/** One segment of the line. */
export interface GuidePathSegment {
  label: string;
  /** The guide opened it on its way to this stop: the page, a tab, a section or a menu. */
  opened: boolean;
}

/** A label as the line shows it: one line of text, cut at `MAX_LABEL_CHARS`. */
export function segmentLabel(text: string): string {
  const label = text.replace(/\s+/g, ' ').trim();
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : label;
}

/**
 * The line's segments: the page's crumbs, its last one opened when the guide
 * opened the page, then the tabs and sections inside it. Empty labels and a
 * label repeating the one before are dropped, and so is the `Home` root when
 * more follows; past `MAX_PATH_SEGMENTS`, the first ones fold into one `…`.
 */
export function guidePath(
  crumbs: readonly string[],
  inner: readonly GuidePathSegment[],
  pageOpened: boolean,
): GuidePathSegment[] {
  const page = crumbs.map(segmentLabel).filter(Boolean);
  const all: GuidePathSegment[] = [
    ...page.map((label, i) => ({ label, opened: pageOpened && i === page.length - 1 })),
    ...inner.map((segment) => ({ ...segment, label: segmentLabel(segment.label) })),
  ];
  const kept = all.filter((segment, i) => segment.label && segment.label !== all[i - 1]?.label);
  if (kept.length > 1 && kept[0]!.label === ROOT_CRUMB) kept.shift();
  if (kept.length <= MAX_PATH_SEGMENTS) return kept;
  return [{ label: '…', opened: false }, ...kept.slice(kept.length - MAX_PATH_SEGMENTS + 1)];
}

/** How a link leads to a route: to the route itself, to its page with no query of its own, or not at all. */
export type LinkMatch = 'route' | 'page' | null;

/**
 * Whether a link to `href` leads to `route`, both URLs of the same origin: the
 * same path, and every query value the link names one `route` names too.
 * `route` when the link names all of them, `page` when it names only some or
 * none, so the guide selects the rest; a link naming another tab leads elsewhere.
 */
export function linkMatch(href: string, route: string): LinkMatch {
  const link = new URL(href, 'http://guide.invalid');
  const target = new URL(route, 'http://guide.invalid');
  if (
    link.origin !== target.origin ||
    link.pathname.replace(/(.)\/$/, '$1') !== target.pathname.replace(/(.)\/$/, '$1')
  ) {
    return null;
  }
  const named = [...link.searchParams.keys()];
  if (named.some((key) => link.searchParams.get(key) !== target.searchParams.get(key))) return null;
  if (named.length === 0) return target.search ? 'page' : 'route';
  return [...target.searchParams.keys()].every((key) => link.searchParams.has(key)) ? 'route' : 'page';
}

/** The query values of `to` that `from` does not hold already: what the move to `to` selects on its page. */
export function changedQuery(from: string | null, to: string): Array<[string, string]> {
  const before = new URL(from ?? '/', 'http://guide.invalid').searchParams;
  const after = new URL(to, 'http://guide.invalid').searchParams;
  return [...after.entries()].filter(([key, value]) => before.get(key) !== value);
}
