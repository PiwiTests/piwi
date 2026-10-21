import { BUG_EVIDENCE_LIMITS, type BugConsoleEntry, type BugFailedRequest } from '@piwitests/core/bug-report';
import type { PiwiSteps } from '@piwitests/core/steps';
import { sessionArea } from './session-area.js';
import type { RequestCondition } from './request-conditions.js';
import type { FallbackReason, ReplayDriver } from './cdp-input.js';

/**
 * A running replay, in session storage so it survives the navigations it
 * causes: every page of the origin loads the replay script again, and it picks
 * up at `position`.
 */
export const REPLAY_KEY = 'piwiReplay';

/**
 * `skipped`: a step the person chose to leave out, such as a file they did
 * not choose. `manual`: a step the replay could not play, which the person
 * did on the page.
 */
type ReplayStepStatus = 'done' | 'passed' | 'failed' | 'diverged' | 'skipped' | 'manual';

export interface ReplayStepResult {
  status: ReplayStepStatus;
  /** Why a step diverged, or what an assertion found. */
  detail: string | null;
  /** What the page showed for an assertion that did not hold. */
  found?: string | null;
  /** How an action step acted: trusted input, or the page's own events. */
  driver?: ReplayDriver;
}

type ReplayStatus = 'running' | 'paused' | 'done' | 'stopped';

export interface ReplayState {
  id: string;
  steps: PiwiSteps;
  /** The origin the steps replay on, such as `http://localhost:3000`. */
  origin: string;
  position: number;
  results: ReplayStepResult[];
  status: ReplayStatus;
  /** Wait for Next before each step. */
  stepMode: boolean;
  /** Where the fake cursor was, in viewport pixels, so the next page starts it there. */
  cursor: { x: number; y: number } | null;
  startedAt: number;
  /**
   * Set when the replay starts on the tab's page instead of opening the first
   * recorded one, whose address may differ (another id, other parameters).
   * Steps recorded on that page play on this one, whatever its address.
   */
  startPage?: { recorded: string; actual: string } | null;
  /** The request conditions on in the tab when the replay started (Slow down or fail a request). */
  conditions?: RequestCondition[];
  /** The connected instance's bug report the steps came from, when they did. */
  bugReportId?: number | null;
  /** In a report made from a test run, the step the test failed at in that run (its `export` block's `failedStep`). */
  runFailedStep?: number | null;
  /** Announced to the main-world evidence script, whose entries carry it back (see `shared/bug-relay.ts`). */
  evidenceToken?: string;
  /**
   * How the replay acts, chosen on its first page: trusted input through the
   * debugging protocol, or the page's own events, with why. Once on the
   * page's events, it stays there.
   */
  driver?: { driver: ReplayDriver; reason: FallbackReason | null } | null;
  /**
   * The viewport the steps were recorded at from the current step on, when
   * they say one, and whether the replay set it on the tab (it can only with
   * trusted input).
   */
  viewport?: { width: number; height: number; set: boolean } | null;
  /** The step the replay could not play and handed to the person, waiting for them, and why. */
  handOver?: { step: number; reason: string } | null;
  /**
   * Set once the replay has ended for good: its tab showed the verdict and
   * told the worker, or the tab was closed. A replay stopped or done without
   * it shows its verdict on the next page its tab loads.
   */
  finished?: boolean;
}

function isReplayState(value: unknown): value is ReplayState {
  const v = value as Partial<ReplayState> | null;
  return !!v && typeof v.origin === 'string' && typeof v.position === 'number' && Array.isArray(v.results) && !!v.steps;
}

export async function getReplayState(): Promise<ReplayState | null> {
  const stored = await sessionArea().get(REPLAY_KEY);
  const value = stored[REPLAY_KEY];
  return isReplayState(value) ? value : null;
}

export async function setReplayState(state: ReplayState): Promise<void> {
  await sessionArea().set({ [REPLAY_KEY]: state });
}

/**
 * Changes the stored replay. With `replayId`, only that replay: a replay
 * started meanwhile is left as it is, and the answer is null.
 */
export async function updateReplayState(
  change: (state: ReplayState) => ReplayState,
  replayId?: string,
): Promise<ReplayState | null> {
  const state = await getReplayState();
  if (!state || (replayId !== undefined && state.id !== replayId)) return null;
  const next = change(state);
  await setReplayState(next);
  return next;
}

/**
 * The tab a replay plays in. Only the background worker writes it, apart
 * from the replay's own state, which the replay script rewrites on every step.
 */
const REPLAY_TAB_KEY = 'piwiReplayTab';

export interface ReplayTab {
  replayId: string;
  tabId: number;
  /**
   * The tabs the replay's tab opened while the replay ran (a link to a new
   * tab, `window.open`): the first of them whose page plays the replay takes
   * it on, as the recording went on there.
   */
  opened?: number[];
}

export async function getReplayTab(): Promise<ReplayTab | null> {
  const value = (await sessionArea().get(REPLAY_TAB_KEY))[REPLAY_TAB_KEY] as Partial<ReplayTab> | undefined;
  if (typeof value?.replayId !== 'string' || typeof value.tabId !== 'number') return null;
  const opened = Array.isArray(value.opened) ? value.opened.filter((id) => typeof id === 'number') : [];
  return { replayId: value.replayId, tabId: value.tabId, ...(opened.length ? { opened } : {}) };
}

export async function setReplayTab(tab: ReplayTab): Promise<void> {
  await sessionArea().set({ [REPLAY_TAB_KEY]: tab });
}

/** A new replay of `steps` on `origin`, from its first step. */
export function newReplayState(
  steps: PiwiSteps,
  origin: string,
  stepMode: boolean,
  now = Date.now(),
  startPage: ReplayState['startPage'] = null,
  bugReportId: number | null = null,
  runFailedStep: number | null = null,
): ReplayState {
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    steps,
    origin,
    position: 0,
    results: [],
    status: 'running',
    stepMode,
    cursor: null,
    startedAt: now,
    startPage,
    bugReportId,
    ...(runFailedStep != null ? { runFailedStep } : {}),
    evidenceToken: `${now.toString(36)}${Math.random().toString(36).slice(2, 12)}`,
  };
}

/**
 * The console errors and failed requests the page showed during a replay, kept
 * apart from the replay's state (which each step rewrites whole) under the
 * replay's evidence token: entries from an older replay are dropped.
 */
const REPLAY_EVIDENCE_KEY = 'piwiReplayEvidence';

export interface ReplayEvidence {
  token: string;
  console: BugConsoleEntry[];
  requests: BugFailedRequest[];
}

export async function getReplayEvidence(token: string | undefined): Promise<ReplayEvidence | null> {
  if (!token) return null;
  const value = (await sessionArea().get(REPLAY_EVIDENCE_KEY))[REPLAY_EVIDENCE_KEY] as ReplayEvidence | undefined;
  return value?.token === token ? value : { token, console: [], requests: [] };
}

/** Adds entries to the replay's evidence, up to the limits a report keeps. */
export async function appendReplayEvidence(
  token: string,
  entries: { console: BugConsoleEntry[]; requests: BugFailedRequest[] },
): Promise<void> {
  const current = (await getReplayEvidence(token))!;
  await sessionArea().set({
    [REPLAY_EVIDENCE_KEY]: {
      token,
      console: [...current.console, ...entries.console].slice(0, BUG_EVIDENCE_LIMITS.console),
      requests: [...current.requests, ...entries.requests].slice(0, BUG_EVIDENCE_LIMITS.requests),
    },
  });
}
