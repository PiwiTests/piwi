/**
 * The nudges: rare suggestions a page offers when a rule over what it already
 * loaded holds, each offering an authored guide or a question for the
 * assistant. All pure: a nudge's rule reads the facts its page hands it, and no
 * model is ever called to choose one. `AssistantNudge` shows the one a page
 * view gets, within the browser's weekly budget (`budget.ts`), until the user
 * dismisses it for good.
 */
import type { AssistantNudgeId } from '#shared/assistant-nudges';
import type { CapabilityId, CapabilityState } from '#shared/capabilities';
import type { Permission } from '#shared/permissions';
import type { DiagnosisContextCoverage } from '~~/types/api';
import { AUTHORED_GUIDES } from '~/utils/guides/guides';
import { guideAvailable, type GuideViewer } from '~/utils/guides/run';
import type { AuthoredGuide } from '~/utils/guides/types';
import { describeScmStatus } from '~/utils/scm-status';

/** The facts each page a nudge shows on hands it, by the page's pattern of `app/pages`; all loaded by the page already. */
export interface NudgePageFacts {
  '/setup': {
    /** Optional capabilities with neither data nor a decision (the core rows aside). */
    undecided: number;
  };
  '/failure-clusters/[id]': {
    /** The cluster has a completed diagnosis. */
    diagnosed: boolean;
    /** The commits the diagnosis context could read, from its coverage. */
    scm: DiagnosisContextCoverage['scm'] | undefined;
  };
  '/test-run-cases/[id]': {
    /** The section the leading clue cites, from the evidence hint, or null. */
    clueSection: string | null;
    /** The execution failed on a timeout. */
    isTimeout: boolean;
    /** The capture fixtures' state on the execution's project. */
    fixturesState: CapabilityState;
  };
}

export type NudgePage = keyof NudgePageFacts;

/** What a nudge offers: an authored guide, by its id, or a question the assistant's panel opens on and asks. */
export type NudgeOffer = { kind: 'guide'; guide: string } | { kind: 'question'; question: string };

interface NudgeOn<P extends NudgePage> {
  id: AssistantNudgeId;
  /** The page it shows on. */
  page: P;
  /** Its rule, over the page's facts. */
  when: (facts: NudgePageFacts[P]) => boolean;
  offer: NudgeOffer;
  /** At most 60 characters, plain text. */
  title: string;
  /** One or two sentences, plain text, in the docs' voice. */
  body: string;
  /** What the user and the instance need, in the guides' vocabulary; a guide offer also needs its guide's `requires`. */
  requires: { capability?: CapabilityId; permission?: Permission };
}

export type Nudge = { [P in NudgePage]: NudgeOn<P> }[NudgePage];

/** The clue sections whose evidence the capture fixtures provide. */
const FIXTURE_BACKED_SECTIONS = new Set<string>(['networkRequests', 'serverLogs', 'console']);

/** Every nudge, in the order a page tries them. */
export const NUDGES: readonly Nudge[] = [
  {
    id: 'undecided-capabilities',
    page: '/setup',
    when: ({ undecided }) => undecided > 0,
    offer: {
      kind: 'question',
      question: 'Which of the capabilities not set up on this instance would my runs use, and what does each one need?',
    },
    title: 'Some capabilities are not set up yet',
    body: 'The assistant can read how this instance is set up and say which of them your runs would use, and what each one needs.',
    requires: { permission: 'settings:manage' },
  },
  {
    id: 'diagnosis-without-diff',
    page: '/failure-clusters/[id]',
    // The diagnosis read no diff, and a repository access token is what would let Piwi read it.
    when: ({ diagnosed, scm }) => diagnosed && describeScmStatus(scm).needsToken,
    offer: { kind: 'guide', guide: 'add-scm-token' },
    title: 'The diagnosis did not see the code changes',
    body: 'No SCM token is set for this project or the instance, so Piwi could not read the commits behind this failure. The guide shows where the token goes.',
    requires: {},
  },
  {
    id: 'failure-without-fixtures',
    page: '/test-run-cases/[id]',
    // A timeout, or a leading clue from a source the fixtures capture, while the project has not decided on them.
    when: ({ clueSection, isTimeout, fixturesState }) =>
      fixturesState === 'undecided' && (isTimeout || (clueSection != null && FIXTURE_BACKED_SECTIONS.has(clueSection))),
    offer: { kind: 'guide', guide: 'add-capture-fixtures' },
    title: 'Record the requests behind failures like this one',
    body: 'The capture fixtures would have recorded the requests, console output and app state behind this failure. The guide shows what they record and where it appears.',
    requires: {},
  },
];

/** Who a nudge is for: the guides' viewer, whether the assistant can answer here, and what the user dismissed. */
export interface NudgeViewer extends GuideViewer {
  /** An AI model answers the assistant's questions on this instance. */
  canAsk: boolean;
  dismissed: ReadonlySet<string>;
}

/** The authored guide `nudge` offers, or null for a question. */
export function nudgeGuide(nudge: Nudge): AuthoredGuide | null {
  const offer = nudge.offer;
  return offer.kind === 'guide' ? (AUTHORED_GUIDES.find((guide) => guide.id === offer.guide) ?? null) : null;
}

/**
 * Whether `nudge` may show to `viewer`, its rule aside: not dismissed, its
 * `requires` held, and its offer available (the guide listed for the viewer,
 * or an assistant that can answer the question).
 */
export function nudgeOffered(nudge: Nudge, viewer: NudgeViewer): boolean {
  if (viewer.dismissed.has(nudge.id)) return false;
  const { capability, permission } = nudge.requires;
  if (capability && viewer.isHidden(capability)) return false;
  if (permission && !viewer.holds(permission)) return false;
  if (nudge.offer.kind === 'question') return viewer.canAsk;
  const guide = nudgeGuide(nudge);
  return guide !== null && guideAvailable(guide, viewer);
}

/** The first nudge of `page` offered to `viewer` whose rule holds over `facts`, or null. */
export function pickNudge<P extends NudgePage>(page: P, facts: NudgePageFacts[P], viewer: NudgeViewer): Nudge | null {
  for (const nudge of NUDGES) {
    if (nudge.page !== page || !nudgeOffered(nudge, viewer)) continue;
    // A nudge on `page` reads that page's facts.
    if ((nudge as unknown as NudgeOn<P>).when(facts)) return nudge;
  }
  return null;
}
