/**
 * The execution timeline's step table, read as Playwright's step tree: which
 * steps it lists, how deep each one sits, which step failed (and which errors
 * the test caught), and the setup and teardown sections (hooks and fixtures)
 * that fold around the test body. Also the geometry of its duration bars on the
 * test's clock, which edges of the axis window cut a bar, and which rows the
 * Most likely line cites.
 */
import type { FailureTimeline, TimelineItem, TimelineRef, TimelineWindow } from '#shared/failure-timeline';
import type { PerformanceStep } from '~~/types/api';
import {
  failingStepIndex,
  isCaptureStep,
  isPhaseContainer,
  stepFailureRoles,
  stepHookName,
  stepParents,
  stepPhases,
  type StepFailureRole,
  type StepPhase,
} from '#shared/step-tree';

/** A folded section of the table: what ran before or after the test body. */
export interface StepSectionSummary {
  /** Wall-clock time of the section, from Playwright's `Before Hooks` / `After Hooks` spans. */
  durationMs: number;
  /** The hooks it ran, by short name (`beforeAll`, `hook "seed"`), in order. */
  hooks: string[];
  /** The fixtures it set up or tore down, by name, in order. */
  fixtures: string[];
  /** Whether a step in it failed; an error the test caught does not count. */
  failed: boolean;
}

export interface StepTreeView {
  phases: StepPhase[];
  /** The step that failed — the innermost of the failing chain — or null. */
  failingIndex: number | null;
  /** Each step's part in the failure (null for a step that passed), see `stepFailureRoles`. */
  roles: Array<StepFailureRole | null>;
  /** Steps the table never lists: the capture's own and the phase containers. */
  hidden: Set<number>;
  /** How deep each step sits, not counting the phase containers. */
  level: number[];
  /** Steps that hold other steps (a `test.step`, a hook, a fixture). */
  groups: Set<number>;
  sections: { setup: StepSectionSummary | null; teardown: StepSectionSummary | null };
}

/** A fixture's name out of its short name (`fixture "db"` → `db`). */
function fixtureName(hookName: string): string {
  return /^fixture "(.+)"$/.exec(hookName)?.[1] ?? hookName;
}

/**
 * Read a stored step list as a tree: phases, levels, the failing step and the
 * folded sections. `error` is the execution's error text, which tells the step
 * that failed the test from an error the test caught.
 */
export function buildStepTreeView(steps: PerformanceStep[], error?: string | null): StepTreeView {
  const parents = stepParents(steps);
  const phases = stepPhases(steps, parents);
  const failingIndex = failingStepIndex(steps, parents, error);
  const roles = stepFailureRoles(steps, error, parents, failingIndex);
  const hidden = new Set<number>();
  const groups = new Set<number>();
  steps.forEach((step, i) => {
    if (isCaptureStep(step) || isPhaseContainer(step)) hidden.add(i);
    if (parents[i] !== -1) groups.add(parents[i]!);
  });

  const level = steps.map((_, i) => {
    let depth = 0;
    for (let p = parents[i]!; p !== -1; p = parents[p]!) if (!isPhaseContainer(steps[p]!)) depth++;
    return depth;
  });

  const summarize = (phase: 'setup' | 'teardown'): StepSectionSummary | null => {
    const indices = steps.map((_, i) => i).filter((i) => phases[i] === phase);
    if (indices.length === 0) return null;
    const hooks: string[] = [];
    const fixtures: string[] = [];
    let durationMs = 0;
    let failed = false;
    for (const i of indices) {
      const step = steps[i]!;
      if (isPhaseContainer(step) && parents[i] === -1) durationMs += step.duration || 0;
      if (hidden.has(i)) continue;
      if (roles[i] && roles[i] !== 'recovered') failed = true;
      const name = stepHookName(step);
      if (!name) continue;
      if (step.category === 'fixture') {
        const fixture = fixtureName(name);
        if (!fixtures.includes(fixture)) fixtures.push(fixture);
      } else if (!hooks.includes(name)) {
        hooks.push(name);
      }
    }
    return { durationMs, hooks, fixtures, failed };
  };

  return {
    phases,
    failingIndex,
    roles,
    hidden,
    level,
    groups,
    sections: { setup: summarize('setup'), teardown: summarize('teardown') },
  };
}

/** One line naming what a folded section ran: `beforeAll · beforeEach · 3 fixtures`. */
export function sectionSummaryText(summary: StepSectionSummary): string {
  const parts = [...summary.hooks];
  const n = summary.fixtures.length;
  if (n > 0) parts.push(n <= 2 ? `fixture${n === 1 ? '' : 's'} ${summary.fixtures.join(', ')}` : `${n} fixtures`);
  return parts.join(' · ');
}

/** A run of consecutive table rows that belong to one section. */
export interface RowBlock<R> {
  section: StepPhase;
  rows: R[];
}

/**
 * Split the table rows, already in time order, into consecutive section blocks.
 * A step row belongs to its step's phase; any other row (a request, a console
 * entry) joins the step row before it — or, at the top, the first one after it.
 */
export function groupRowsBySection<R>(rows: R[], stepPhase: (row: R) => StepPhase | null): Array<RowBlock<R>> {
  const own = rows.map(stepPhase);
  const firstKnown = own.find((phase): phase is StepPhase => phase !== null) ?? 'body';
  const blocks: Array<RowBlock<R>> = [];
  let current: StepPhase = firstKnown;
  rows.forEach((row, i) => {
    current = own[i] ?? current;
    const last = blocks[blocks.length - 1];
    if (last && last.section === current) last.rows.push(row);
    else blocks.push({ section: current, rows: [row] });
  });
  return blocks;
}

// ── Duration bars and the window's cut edges ─────────────────────────────────

/** Where a duration's bar sits on its track, in percent of the track. */
export interface BarPlace {
  left: number;
  width: number;
}

/** A bar's track on the timeline's clock, in ms: where it starts and how long it runs. */
export interface BarTrack {
  start: number;
  length: number;
}

/** The narrowest bar, in percent of its track, so a short step or request still shows. */
export const MIN_BAR_PERCENT = 1.5;

/**
 * The test's track on a built timeline: from the test's start, as long as the
 * test (`durationMs`), else up to the timeline's end. Evidence stamped before
 * the test started moves the timeline's origin, never the test's bars. A test
 * that stood paused ran longer on the clock than the duration Playwright
 * reports for it, which leaves the stops out: its track runs to the end of its
 * last step or stop.
 */
export function testTrack(
  timeline: Pick<FailureTimeline, 'origin' | 'end' | 'testStart'> & Partial<Pick<FailureTimeline, 'lanes' | 'pauses'>>,
  durationMs: number | null | undefined,
): BarTrack {
  const start = timeline.testStart;
  let length = durationMs != null && durationMs > 0 ? durationMs : timeline.end - timeline.origin - start;
  if (timeline.pauses?.length) {
    let end = start;
    for (const span of [...(timeline.lanes?.steps ?? []), ...timeline.pauses]) {
      end = Math.max(end, span.at + (span.duration ?? 0));
    }
    length = end - start;
  }
  return { start, length: Math.max(1, length) };
}

/**
 * The test's track from its own steps, when every step carries its start: from
 * the first step, as long as the test (`durationMs`), else up to the last
 * step's end; with stops, up to the end of its last step or stop, as
 * `testTrack`. Null without step start times.
 */
export function stepsTrack(
  steps: ReadonlyArray<{ startTime?: number; duration?: number }>,
  durationMs: number | null | undefined,
  pauses: ReadonlyArray<{ startedAt: number; duration: number }> = [],
): BarTrack | null {
  if (steps.length === 0 || !steps.every((step) => typeof step.startTime === 'number')) return null;
  const start = Math.min(...steps.map((step) => step.startTime as number));
  let end = Math.max(...steps.map((step) => (step.startTime as number) + (step.duration || 0)));
  let length = durationMs != null && durationMs > 0 ? durationMs : end - start;
  if (pauses.length > 0) {
    for (const pause of pauses) end = Math.max(end, pause.startedAt + pause.duration);
    length = end - start;
  }
  return { start, length: Math.max(1, length) };
}

/**
 * Place a bar spanning `[at, at + duration]` on its track, clamped to it: a bar
 * that starts before the track starts at its left edge, one that outlasts it
 * runs to its right edge, and none is narrower than `MIN_BAR_PERCENT`.
 */
export function barPlace(at: number, duration: number | null | undefined, track: BarTrack): BarPlace {
  const length = Math.max(1, track.length);
  const percent = (ms: number) => ((ms - track.start) / length) * 100;
  const left = Math.min(100 - MIN_BAR_PERCENT, Math.max(0, percent(at)));
  const right = Math.min(100, Math.max(left + MIN_BAR_PERCENT, percent(at + Math.max(0, duration ?? 0))));
  return { left, width: right - left };
}

/** Which edges of the axis window cut a bar: it started before the window, or runs on past it. */
export interface WindowCuts {
  start: boolean;
  end: boolean;
}

/** The edges of `window` that cut a span starting at `at` and lasting `duration` ms. */
export function windowCuts(
  span: { at: number; duration?: number | null },
  window: Pick<TimelineWindow, 'start' | 'end'>,
): WindowCuts {
  return { start: span.at < window.start, end: span.at + Math.max(0, span.duration ?? 0) > window.end };
}

/** What a cut bar's tooltip says about the window; null when the window holds the whole bar. */
export function windowCutText(cuts: WindowCuts): string | null {
  if (cuts.start && cuts.end) return 'Started before and runs on past this window';
  if (cuts.start) return 'Started before this window';
  if (cuts.end) return 'Runs on past this window';
  return null;
}

// ── The rows the Most likely line cites ──────────────────────────────────────

/** A clue's citation: a section and, when it names one entry, its index in that section's list. */
export interface TimelineCitation {
  section: string;
  index?: number;
}

/**
 * The ids of the timeline items a list of citations names. A request, a console
 * entry, a dialog or a step cited by index is its own item, and a request's
 * backend logs are that request; a citation of the failing steps, or of the steps
 * with no index, is the step that failed. Any other section names no item.
 */
export function citedItemIds(items: readonly TimelineItem[], citations: readonly TimelineCitation[]): Set<string> {
  const byRef = (section: TimelineRef['section'], index: number | undefined) =>
    index == null ? [] : items.filter((item) => item.ref.section === section && item.ref.index === index);
  const ids = new Set<string>();
  for (const cite of citations) {
    let found: readonly TimelineItem[] = [];
    switch (cite.section) {
      case 'networkRequests':
      case 'serverLogs':
      case 'backendLogs':
        found = byRef('networkRequests', cite.index);
        break;
      case 'console':
      case 'dialogs':
        found = byRef(cite.section, cite.index);
        break;
      case 'steps':
        found =
          cite.index == null ? items.filter((item) => item.kind === 'step' && item.failed) : byRef('steps', cite.index);
        break;
      case 'failingSteps':
        found = items.filter((item) => item.kind === 'step' && item.failed);
        break;
    }
    for (const item of found) ids.add(item.id);
  }
  return ids;
}
