/**
 * The guide anchors a question can be shown on: which anchors render for a
 * user here (their `requires`), the ones a query names, best first with the
 * user's page first, and the markup a guide's copy may hold. The server's
 * assistant answers `find_anchors` and checks guide plans with them, and the
 * demo's prepared answers compose their guides with them.
 */
import { GUIDE_ANCHORS, type GuideAnchor } from '#shared/guide-anchors/index.mjs';
import type { AssistantPageContext } from '#shared/assistant';
import type { CapabilityId, CapabilityState } from '#shared/capabilities';
import { can, holdsAnywhere, type AccessSummary } from '#shared/permissions';
import { isFixedPage, routeOnPage } from '#shared/guide-stops';

/** The most anchors one search returns. */
const FIND_ANCHORS_LIMIT = 8;

/** What an anchor's `requires` is checked against. */
export interface AnchorFacts {
  /** The instance's capability states. */
  states: Record<CapabilityId, CapabilityState>;
  /**
   * The capability states of the projects read so far, by id: each project's
   * own decisions over the instance's. An anchor on a page of one of them
   * follows its project's states.
   */
  projectStates?: ReadonlyMap<number, Record<CapabilityId, CapabilityState>>;
  access: AccessSummary;
  desktop: boolean;
}

/** The pages whose `[id]` is a project, or a run, execution, failure cluster, test or bug report of one. */
const PROJECT_PAGE = /^\/(?:projects|test-runs|test-run-cases|failure-clusters|test-cases|bug-reports)\/\[id\](?:\/|$)/;

/**
 * The capability states of project `projectId` when `anchor` renders on its
 * pages (the anchor's main page is a project's, or one of its entities') and
 * they were read; null when the instance's states apply.
 */
export function projectStatesFor(
  anchor: GuideAnchor,
  facts: AnchorFacts,
  projectId: number | null,
): Record<CapabilityId, CapabilityState> | null {
  if (projectId === null || !PROJECT_PAGE.test(anchor.pages[0] ?? '*')) return null;
  return facts.projectStates?.get(projectId) ?? null;
}

/**
 * Why an anchor does not render for this user here, or null when it does. A
 * permission is checked on `projectId` when the page shows a project, on any
 * project otherwise; a capability on the project's states on its pages, on
 * the instance's otherwise.
 */
export function anchorUnavailable(anchor: GuideAnchor, facts: AnchorFacts, projectId: number | null): string | null {
  const requires = anchor.requires;
  if (!requires) return null;
  if (requires.demo) return 'it shows in the live demo only';
  if (requires.desktop && !facts.desktop) return 'it shows in the desktop app only';
  if (requires.capability) {
    const hidden = (state: CapabilityState) => state === 'declined' || state === 'not-applicable';
    const project = projectStatesFor(anchor, facts, projectId);
    const state = (project ?? facts.states)[requires.capability];
    if (hidden(state)) {
      const where = hidden(facts.states[requires.capability]) ? 'on this instance' : `for project ${projectId}`;
      return `it needs the ${requires.capability} capability, ${state} ${where}`;
    }
  }
  if (requires.permission) {
    const holds =
      projectId !== null
        ? can(facts.access, requires.permission, projectId)
        : holdsAnywhere(facts.access, requires.permission);
    if (!holds) {
      return `it needs the ${requires.permission} permission${projectId !== null ? ` on project ${projectId}` : ''}, which the user does not hold`;
    }
  }
  return null;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'where',
  'what',
  'which',
  'can',
  'does',
  'with',
  'this',
  'that',
]);

/** A word as matched: lower case, a plural `s` dropped. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map(stem);
}

/** Whether a query word names a text's word: the same, or one starting the other when both are long. */
function matches(word: string, tokens: readonly string[]): boolean {
  return tokens.some(
    (t) => t === word || (word.length >= 5 && t.startsWith(word)) || (t.length >= 5 && word.startsWith(t)),
  );
}

/** Whether `route` opens one of the anchor's pages. */
function rendersOn(anchor: GuideAnchor, route: string | null | undefined): boolean {
  return route ? anchor.pages.some((page) => routeOnPage(route, page)) : false;
}

/** Whether a stop at this anchor needs a route: its main page has an id, and the user is not on one of its pages. */
export function needsRoute(anchor: GuideAnchor, route: string | null | undefined): boolean {
  const main = anchor.pages[0] ?? '*';
  return main !== '*' && !isFixedPage(main) && !rendersOn(anchor, route);
}

/** One anchor a query names: whether it is on the user's page, and how well it matches. */
export interface AnchorMatch {
  anchor: GuideAnchor;
  score: number;
  here: boolean;
}

/**
 * The anchors matching a query that render for this user: those on the
 * user's page first, then the others, each best first. Each query word found
 * in the id, the description, the help topic, the kind or the condition
 * scores. The page's anchors are the ones the browser listed as rendered when
 * the question was asked, or, without that list, those of the page its route
 * opens; the layout's, on every page, are not counted as the page's.
 */
export function rankAnchors(
  query: string,
  facts: AnchorFacts,
  context: AssistantPageContext | null,
  limit = FIND_ANCHORS_LIMIT,
): AnchorMatch[] {
  const wanted = words(query);
  const projectId = context?.projectId ?? null;
  const rendered = context?.anchors ? new Set(context.anchors) : null;
  return GUIDE_ANCHORS.filter((anchor) => !anchorUnavailable(anchor, facts, projectId))
    .map((anchor) => {
      const fields: Array<[string, number]> = [
        [anchor.id, 3],
        [anchor.describes, 2],
        [anchor.help ?? '', 2],
        [anchor.kind, 1],
        [anchor.shownWhen ?? '', 1],
      ];
      const tokens = fields.map(([text, weight]) => [words(text), weight] as const);
      const score = wanted.reduce(
        (n, w) => n + tokens.reduce((m, [t, weight]) => m + (matches(w, t) ? weight : 0), 0),
        0,
      );
      const here = anchor.pages[0] !== '*' && (rendered ? rendered.has(anchor.id) : rendersOn(anchor, context?.route));
      return { anchor, score, here };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => Number(b.here) - Number(a.here) || b.score - a.score)
    .slice(0, limit);
}

/** What `find_anchors` answers: the anchors {@link rankAnchors} finds, as the model reads them, or a note. */
export function findAnchors(query: string, facts: AnchorFacts, context: AssistantPageContext | null) {
  const scored = rankAnchors(query, facts, context);
  if (scored.length === 0) {
    return {
      anchors: [],
      note: 'No anchor matches. Try the words the dashboard uses (a page, a tab, a section or a setting), or answer without a guide.',
    };
  }
  return {
    anchors: scored.map(({ anchor, here }) => ({
      id: anchor.id,
      kind: anchor.kind,
      pages: anchor.pages,
      describes: anchor.describes,
      ...(anchor.shownWhen ? { shownWhen: anchor.shownWhen } : {}),
      ...(here ? { onThisPage: true } : {}),
      ...(needsRoute(anchor, context?.route) ? { needsRoute: true } : {}),
    })),
  };
}

/** Why guide copy uses markup other than `**bold**`, or null. */
export function guideMarkupProblem(text: string): string | null {
  const rest = text.replace(/\*\*[^*\n]+?\*\*/g, '');
  if (rest.includes('*')) return 'a lone * (only **bold** is allowed)';
  if (rest.includes('`')) return 'backticks (only **bold** is allowed)';
  if (/<[a-z/!]/i.test(rest)) return 'HTML (only **bold** is allowed)';
  if (/\]\(/.test(rest)) return 'a link (only **bold** is allowed; the stop links its docs page itself)';
  if (/[\r\n]/.test(rest)) return 'a line break (one paragraph)';
  return null;
}
