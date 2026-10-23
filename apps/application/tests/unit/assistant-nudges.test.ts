/**
 * The nudges (`app/utils/nudges/`): the registry against the ids the routes
 * accept, the pages that place them and the guides they offer; each rule
 * showing and not showing; what keeps one from a user (a dismissal, its
 * `requires`, a guide not listed for them, a question with no model to ask);
 * and the browser's weekly budget.
 */
import { describe, expect, test } from 'vitest';
import { ASSISTANT_MAX_QUESTION_CHARS } from '#shared/assistant';
import { ASSISTANT_NUDGE_IDS, isAssistantNudgeId } from '#shared/assistant-nudges';
import type { CapabilityId, CapabilityState } from '#shared/capabilities';
import type { Permission } from '#shared/permissions';
import type { DiagnosisContextCoverage } from '~~/types/api';
import { AUTHORED_GUIDES } from '~/utils/guides/guides';
import {
  NUDGE_BUDGET,
  NUDGE_BUDGET_WINDOW_MS,
  parseNudgeShows,
  recentNudgeShows,
  takeNudgeBudget,
} from '~/utils/nudges/budget';
import {
  NUDGES,
  nudgeGuide,
  nudgeOffered,
  pickNudge,
  type Nudge,
  type NudgePageFacts,
  type NudgeViewer,
} from '~/utils/nudges/nudges';
import { appSource, PAGE_FILES, PAGES } from './guide-anchor-source';

type ScmCoverage = NonNullable<DiagnosisContextCoverage['scm']>;

/** A viewer who holds every permission, on an instance with nothing hidden, an AI model and no dismissal. */
function viewer(overrides: Partial<NudgeViewer> = {}): NudgeViewer {
  return { isHidden: () => false, holds: () => true, canAsk: true, dismissed: new Set(), ...overrides };
}

const nudge = (id: string): Nudge => NUDGES.find((n) => n.id === id)!;

/** The commits of a cluster on GitHub, the range known, no diff read and no token set. */
const NO_TOKEN: ScmCoverage = {
  hasLastGreen: true,
  hasCommitRange: true,
  baseCommitUsed: null,
  provider: 'github',
  commitsCount: 0,
  filesCount: 0,
  patchedFilesCount: 0,
  patchesOmitted: false,
  patchesTruncated: false,
  baselineKind: 'run-green',
  repositoryUrl: 'https://github.com/acme/shop',
  range: { from: 'a1b2c3d', to: 'e4f5a6b' },
  hasToken: false,
};

const cluster = (facts: Partial<NudgePageFacts['/failure-clusters/[id]']> = {}) =>
  pickNudge('/failure-clusters/[id]', { diagnosed: true, scm: NO_TOKEN, ...facts }, viewer());

const execution = (facts: Partial<NudgePageFacts['/test-run-cases/[id]']> = {}) =>
  pickNudge(
    '/test-run-cases/[id]',
    { clueSection: null, isTimeout: false, fixturesState: 'undecided', ...facts },
    viewer(),
  );

describe('the nudge registry', () => {
  test('holds every id the dismissal routes accept, once each', () => {
    expect(NUDGES.map((n) => n.id).sort()).toEqual([...ASSISTANT_NUDGE_IDS].sort());
    expect(isAssistantNudgeId('undecided-capabilities')).toBe(true);
    expect(isAssistantNudgeId('made-up')).toBe(false);
  });

  test('each nudge shows on a page that places it', () => {
    for (const n of NUDGES) {
      expect(PAGES.has(n.page), n.id).toBe(true);
      const tag = new RegExp(`<AssistantNudge\\s+page="${n.page.replace(/[[\]]/g, '\\$&')}"`);
      const placed = (PAGE_FILES.get(n.page) ?? []).some((file) => tag.test(appSource(file)));
      expect(placed, `${n.id}: ${n.page} renders no <AssistantNudge page="${n.page}">`).toBe(true);
    }
  });

  test('copy fits: a plain title of at most 60 characters, one or two plain sentences', () => {
    for (const n of NUDGES) {
      expect(n.title.length, n.id).toBeLessThanOrEqual(60);
      expect(n.title, n.id).toMatch(/^[A-Z][^.*`]*$/);
      expect(n.body.length, n.id).toBeLessThanOrEqual(240);
      expect(n.body, n.id).toMatch(/^[A-Z].*\.$/);
      expect(n.body, n.id).not.toMatch(/[*`]/);
      expect(n.body.split(/(?<=[.!?])\s+/).length, n.id).toBeLessThanOrEqual(2);
    }
  });

  test('a guide offer names an authored guide, and a question fits the question field', () => {
    for (const n of NUDGES) {
      if (n.offer.kind === 'guide') expect(nudgeGuide(n)?.id, n.id).toBe(n.offer.guide);
      else expect(n.offer.question.length, n.id).toBeLessThanOrEqual(ASSISTANT_MAX_QUESTION_CHARS);
    }
    expect(AUTHORED_GUIDES.some((guide) => guide.id === 'add-scm-token')).toBe(true);
  });
});

describe('Setup with undecided capabilities', () => {
  test('offers a question while a capability is undecided', () => {
    const picked = pickNudge('/setup', { undecided: 4 }, viewer());
    expect(picked?.id).toBe('undecided-capabilities');
    expect(picked?.offer.kind).toBe('question');
  });

  test('does not show once every capability is decided or in use', () => {
    expect(pickNudge('/setup', { undecided: 0 }, viewer())).toBeNull();
  });

  test('needs an AI model to ask, and the Setup page’s permission', () => {
    expect(pickNudge('/setup', { undecided: 4 }, viewer({ canAsk: false }))).toBeNull();
    expect(pickNudge('/setup', { undecided: 4 }, viewer({ holds: () => false }))).toBeNull();
  });
});

describe('a diagnosis without the code changes', () => {
  test('offers the SCM token guide when the diagnosis read no diff and no token is set', () => {
    expect(cluster()?.id).toBe('diagnosis-without-diff');
    expect(nudgeGuide(cluster()!)?.id).toBe('add-scm-token');
    // The commits read from a linked folder that lacks them: a token would read them.
    expect(cluster({ scm: { ...NO_TOKEN, localGit: true } })?.id).toBe('diagnosis-without-diff');
  });

  test('does not show without a diagnosis, with a diff, or with a token set', () => {
    expect(cluster({ diagnosed: false })).toBeNull();
    expect(cluster({ scm: { ...NO_TOKEN, commitsCount: 3, filesCount: 5 } })).toBeNull();
    expect(cluster({ scm: { ...NO_TOKEN, hasToken: true, error: 'Not Found' } })).toBeNull();
    expect(cluster({ scm: null })).toBeNull();
    expect(cluster({ scm: undefined })).toBeNull();
  });

  test('does not show when a token would not fill the gap', () => {
    // No commit recorded, no repository, a host Piwi does not read, the same commit as the last pass.
    expect(cluster({ scm: { ...NO_TOKEN, range: null } })).toBeNull();
    expect(cluster({ scm: { ...NO_TOKEN, repositoryUrl: null } })).toBeNull();
    expect(cluster({ scm: { ...NO_TOKEN, provider: null } })).toBeNull();
    expect(cluster({ scm: { ...NO_TOKEN, range: { from: 'a1b2c3d', to: 'a1b2c3d' } } })).toBeNull();
  });
});

describe('a failure leading with a network clue while the capture fixtures are undecided', () => {
  test('offers the capture fixtures guide on a timeout', () => {
    expect(execution({ isTimeout: true })?.id).toBe('failure-without-fixtures');
    expect(nudgeGuide(execution({ isTimeout: true })!)?.id).toBe('add-capture-fixtures');
  });

  test('offers it when the leading clue cites the network, the server logs or the console', () => {
    for (const clueSection of ['networkRequests', 'serverLogs', 'console']) {
      expect(execution({ clueSection })?.id, clueSection).toBe('failure-without-fixtures');
    }
  });

  test('does not show for a clue the fixtures do not capture, or no clue and no timeout', () => {
    expect(execution({ clueSection: 'ariaSnapshot' })).toBeNull();
    expect(execution()).toBeNull();
  });

  test('never shows once the fixtures are anything but undecided', () => {
    const states: CapabilityState[] = ['active', 'available', 'declined', 'not-applicable'];
    for (const fixturesState of states) {
      expect(execution({ clueSection: 'networkRequests', isTimeout: true, fixturesState }), fixturesState).toBeNull();
    }
  });
});

describe('who a nudge is offered to', () => {
  test('never to a user who dismissed it', () => {
    expect(nudgeOffered(nudge('failure-without-fixtures'), viewer())).toBe(true);
    expect(
      nudgeOffered(nudge('failure-without-fixtures'), viewer({ dismissed: new Set(['failure-without-fixtures']) })),
    ).toBe(false);
    expect(
      pickNudge(
        '/test-run-cases/[id]',
        { clueSection: null, isTimeout: true, fixturesState: 'undecided' },
        viewer({ dismissed: new Set(['failure-without-fixtures']) }),
      ),
    ).toBeNull();
  });

  test('not when the guide it offers is not listed for the user', () => {
    const hidden = (id: CapabilityId) => (capability: CapabilityId) => capability === id;
    expect(nudgeOffered(nudge('diagnosis-without-diff'), viewer({ isHidden: hidden('scm') }))).toBe(false);
    expect(nudgeOffered(nudge('failure-without-fixtures'), viewer({ isHidden: hidden('fixtures') }))).toBe(false);
    // The SCM token guide is a Project admin's.
    const holds = (permission: Permission) => permission !== 'project:manage';
    expect(nudgeOffered(nudge('diagnosis-without-diff'), viewer({ holds }))).toBe(false);
    expect(nudgeOffered(nudge('failure-without-fixtures'), viewer({ holds }))).toBe(true);
  });

  test('a guide offer needs no AI model', () => {
    expect(nudgeOffered(nudge('diagnosis-without-diff'), viewer({ canAsk: false }))).toBe(true);
    expect(nudgeOffered(nudge('undecided-capabilities'), viewer({ canAsk: false }))).toBe(false);
  });

  test('only on its own page', () => {
    expect(pickNudge('/setup', { undecided: 3 }, viewer())?.page).toBe('/setup');
    expect(execution({ isTimeout: true })?.page).toBe('/test-run-cases/[id]');
  });
});

describe('the weekly budget', () => {
  const NOW = Date.UTC(2026, 9, 23, 12);
  const DAY = 24 * 60 * 60 * 1000;

  test(`lets ${NUDGE_BUDGET} nudges through in a week, then none`, () => {
    let shown: number[] = [];
    for (let i = 0; i < NUDGE_BUDGET; i++) {
      const next = takeNudgeBudget(shown, NOW + i * DAY);
      expect(next, `nudge ${i + 1}`).not.toBeNull();
      shown = next!;
    }
    expect(shown).toHaveLength(NUDGE_BUDGET);
    expect(takeNudgeBudget(shown, NOW + NUDGE_BUDGET * DAY)).toBeNull();
  });

  test('has room again once the oldest show is a week old', () => {
    const shown = [NOW, NOW + DAY, NOW + 2 * DAY];
    expect(takeNudgeBudget(shown, NOW + NUDGE_BUDGET_WINDOW_MS - 1)).toBeNull();
    expect(takeNudgeBudget(shown, NOW + NUDGE_BUDGET_WINDOW_MS)).toEqual([
      NOW + DAY,
      NOW + 2 * DAY,
      NOW + NUDGE_BUDGET_WINDOW_MS,
    ]);
  });

  test('keeps only the shows inside the window, and ignores a show in the future', () => {
    expect(recentNudgeShows([NOW - NUDGE_BUDGET_WINDOW_MS, NOW - DAY, NOW + DAY], NOW)).toEqual([NOW - DAY]);
  });

  test('reads what the browser stored, and counts anything unreadable as none', () => {
    expect(parseNudgeShows(JSON.stringify({ shown: [NOW, 'x', null, NOW + 1] }))).toEqual([NOW, NOW + 1]);
    expect(parseNudgeShows(null)).toEqual([]);
    expect(parseNudgeShows('not json')).toEqual([]);
    expect(parseNudgeShows(JSON.stringify({ shown: 'x' }))).toEqual([]);
  });
});
