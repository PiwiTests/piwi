/**
 * App-wide registry of local `playwright test` runs driven through the desktop
 * shell.
 *
 * The shell spawns the linked folder's own Playwright with the bundled Node
 * sidecar and streams output back as `piwi:local-run` events; each spawned step
 * carries a shell-assigned id so concurrent runs stay apart. Runs live here —
 * not in any component — so they survive navigation and dialog closes; the
 * runs tray and the run-locally button both render from this store. Stopping a
 * run is always an explicit action, never a side effect of closing UI.
 *
 * A run's plan can have several steps (one per Playwright project); they run
 * sequentially and the worst exit code wins. Output lines may arrive before
 * the invoke that started a step resolves with its id, so unattributed events
 * are buffered and replayed once the id is known.
 *
 * A project's default options are kept per project (localStorage) and edited
 * in its Local folder settings; a run button's own choices apply to the runs it
 * starts, never to those defaults.
 *
 * A reload of the window keeps its runs: as the page goes (`keepForReload`) it
 * writes them to the window's session storage, with each one's Hold failures
 * and separate output, and the next page takes them back
 * (`takeBackAfterReload`), asking the shell which of their processes still run
 * and how those that ended meanwhile exited (`desktop_local_runs`).
 */
import {
  buildBisectArgs,
  buildLocalRunPlan,
  buildReproduceArgs,
  type LocalRunMode,
  type LocalRunOptions,
  type LocalRunStep,
  localRunHoldsFailures,
  stopsAtFirstFailure,
} from '~/utils/local-run-args';
import type { RetryCase, RetryMode } from '~/utils/retry-command';
import { commitUrl } from '#shared/scm-urls';
import { specRunVerdict, type SpecRunResult, type SpecRunVerdict } from '@piwitests/core/bug-report';
import type { PiwiSteps } from '@piwitests/core/steps';
import { desktopJobVerdict, flakeLabJobReport, localRunOriginKind, newLocalRunRef } from '~/utils/desktop-job';
import {
  desktopFailedExecution,
  desktopFailedStep,
  desktopRunOf,
  desktopRunRef,
  desktopShellIdOf,
  type DesktopRunCount,
} from '~/utils/desktop-run-view';
import { runOutputWindowName } from '~/utils/run-output-channel';
import type { HubProgress } from '@piwitests/core/run-hub';
import type { TestRunDetails } from '~~/types/api';
import { progressWords } from '@piwitests/run-model/outcome';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import { stripAnsi } from '@piwitests/run-ui/ansi';
import type { ReproRequestView } from '#shared/desktop-repro';
import { UNATTENDED_RUN_SUFFIX } from '#shared/desktop-runs';
import type { FlakeLabJobReport } from '@piwitests/core/desktop-job';

export type LocalRunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'error';

/**
 * What a run is: a plain test run, a full reproduction (checkout → install →
 * test), a bisect, a bug report's steps run from a repro request, or a Flake
 * Lab session (`piwi flake`) at the commit of a test's latest failure, on a
 * test of this app or on an editor's plan.
 */
export type LocalRunKind = 'tests' | 'reproduce' | 'bisect' | 'repro' | 'flake' | 'request';

/** What a Flake Lab session runs: which arms, how many runs, and its budget. */
export interface FlakeLabOptions {
  /** One suspect's arm (its rank), or null for every arm. */
  suspect: number | null;
  /** Also run every condition at once when none reproduces alone. */
  all: boolean;
  /** Runs of the control and of each arm; null keeps the command's default. */
  runs: number | null;
  /** Start no new arm after this many minutes; null keeps the command's default. */
  budgetMinutes: number | null;
}

/** A Flake Lab session's run: the test it experiments on, and how. */
export interface FlakeLabRunState {
  testCaseId: number;
  options: FlakeLabOptions;
}

/** The command a Flake Lab session runs, as the tray shows it. */
export function flakeLabDisplay(testCaseId: number, options: FlakeLabOptions): string {
  const parts = ['piwi flake', String(testCaseId)];
  if (options.suspect != null) parts.push('--suspect', String(options.suspect));
  else if (options.all) parts.push('--all');
  if (options.runs != null) parts.push('--runs', String(options.runs));
  if (options.budgetMinutes != null) parts.push('--budget', `${options.budgetMinutes}m`);
  return parts.join(' ');
}

/** The command an editor's Flake Lab job runs, as the tray and the confirmation show it. */
export const FLAKE_LAB_JOB_DISPLAY = 'piwi flake --plan <plan from your editor> --json';

/** `piwi flake`'s exit code, read: 0 reproduced, 1 not reproduced, else it could not run. */
export function flakeLabOutcome(code: number | null): 'reproduced' | 'not-reproduced' | 'error' {
  if (code === 0) return 'reproduced';
  if (code === 1) return 'not-reproduced';
  return 'error';
}

/** A repro request's run: the request it answers and, once over, its verdict. */
export interface ReproRunState {
  requestId: string;
  steps: PiwiSteps;
  args: string[];
  /** The bug report the request came from, on the instance that sent it; the run's origin reference. */
  bugReportId?: number | null;
  /** What the spec recorded about its run; null when it recorded nothing. */
  result: SpecRunResult | null;
  verdict: SpecRunVerdict | null;
}

/** The phases a reproduce/bisect/flake run streams a header for. */
export type LocalRunPhase = 'checkout' | 'install' | 'browser' | 'test' | 'bisect' | 'lab';

export type BisectVerdict = 'testing' | 'good' | 'bad' | 'skipped';

/** One commit the bisect visited, and how it turned out. */
export interface BisectCandidate {
  sha: string;
  verdict: BisectVerdict;
}

/** The first bad commit a bisect named, as the shell reported it. */
export interface BisectFirstBad {
  sha: string;
  subject: string;
  author: string | null;
  date: string | null;
}

/** Live bisect state for the tray: the candidates as they fill in and the result. */
export interface BisectState {
  /** 1-based index of the current step, when git announced one. */
  step: number | null;
  /** git's own estimate of the steps remaining ("roughly M steps"). */
  stepsEstimate: number | null;
  candidates: BisectCandidate[];
  firstBad: BisectFirstBad | null;
}

/** Where a bisect result is persisted so it survives a reload. */
export interface BisectTarget {
  clusterId: number | null;
  repositoryUrl: string | null;
}

/**
 * The bisect of this project and cluster that found its first bad commit, the
 * most recent first. A bisect started without a cluster matches only a page
 * without one.
 */
export function findLiveBisect(
  runs: readonly Pick<LocalRun, 'kind' | 'projectId' | 'bisect' | 'bisectTarget'>[],
  projectId: number,
  clusterId: number | null,
): BisectFirstBad | null {
  const run = runs.find(
    (r) =>
      r.kind === 'bisect' &&
      r.projectId === String(projectId) &&
      (r.bisectTarget?.clusterId ?? null) === clusterId &&
      r.bisect?.firstBad,
  );
  return run?.bisect?.firstBad ?? null;
}

/** A commit URL derived from a repository URL, for the "Open commit" action. */
export function bisectCommitUrl(target: BisectTarget | null, sha: string): string | null {
  return commitUrl(target?.repositoryUrl, sha);
}

/** A set of tests a run button offers to run instead of its own: the menu's item and the tray's title. */
export interface LocalRunSet {
  /** The menu item, saying what it runs ("Re-run all 12 tests"). */
  label: string;
  cases: RetryCase[];
  /** What the Local runs tray calls a run of it. */
  runTitle: string;
  /** Options a run of it needs on top of the button's (whole files for a large run). */
  options?: LocalRunOptions;
}

/** Options as stored per project — every field resolved to a concrete value. */
export type SavedLocalRunOptions = Required<LocalRunOptions>;

export interface LocalRunLine {
  /** The line's number in its run, from 1: its key while the run keeps its last `LOCAL_RUN_MAX_LINES`. */
  id: number;
  /** The line without its ANSI color codes. */
  text: string;
  error: boolean;
  /** The line as printed, ANSI color codes included; only on a line that has them and has text. */
  ansi?: string;
}

export interface LocalRun {
  /** Store-unique key — not the shell's per-step run id. */
  key: number;
  kind: LocalRunKind;
  projectId: string;
  projectLabel: string | null;
  /** The cases the run was built from — kept so the tray can re-run it. */
  cases: RetryCase[];
  /** What the run runs, in words, as the page that started it named it; null to derive it (`localRunTitle`). */
  title: string | null;
  /** The Piwi run its cases come from: the run it produced is compared with this one. */
  sourceRunId: number | null;
  options: SavedLocalRunOptions;
  steps: LocalRunStep[];
  stepIndex: number;
  /** The worst exit code of its test steps that ended (kind === 'tests'), 0 while each passed. */
  stepsExit: number | null;
  /** The phase a reproduce/bisect run is in, for the tray header. */
  phase: LocalRunPhase | null;
  /** Browser to install for a reproduce/bisect run. */
  browserName: string | null;
  /** Failing commit to check out (kind === 'reproduce'). */
  commit: string | null;
  /** The failure cluster a reproduce run reproduces, recorded as the run's origin reference (kind === 'reproduce'). */
  clusterId?: number | null;
  /** Bisect window ends (kind === 'bisect'). */
  good: string | null;
  bad: string | null;
  /** Live bisect state (kind === 'bisect'). */
  bisect: BisectState | null;
  /** Where a found bisect result is persisted and linked (kind === 'bisect'). */
  bisectTarget: BisectTarget | null;
  /** The repro request it answers (kind === 'repro'). */
  repro: ReproRunState | null;
  /** The Flake Lab session on a test of this app (kind === 'flake'); null for an editor's plan. */
  flake: FlakeLabRunState | null;
  /** What an editor's Flake Lab job measured, once `piwi flake --json` printed it. */
  labReport: FlakeLabJobReport | null;
  /** A bisect that runs this test's reproducing Flake Lab arm at each step (kind === 'bisect'). */
  flakeTestCaseId: number | null;
  status: LocalRunStatus;
  lines: LocalRunLine[];
  /** The lines the run printed so far, its first ones dropped from `lines` included. */
  linesTotal: number;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** The editor's job this run answers (kind === 'reproduce', 'bisect' or 'flake'). */
  jobRequestId: string | null;
  /** The run request of a team instance it answers (kind === 'request'): the shell reports it there. */
  teamRequest: { id: string; instance: string } | null;
  /**
   * The origin reference the reporter records for this run (`PIWI_ORIGIN_REF`):
   * the cluster or bug report it was launched for, else one made for it alone.
   */
  originRef: string | null;
  /** Shell id of the step currently spawned, for stopping it. */
  shellId: number | null;
  /** A step is being started: the shell has not answered with its id yet. */
  stepStarting: boolean;
  /**
   * The names its steps gave the bundled server, their hub, on its run channel (`desktop-<shell id>`), the latest
   * last: the tray shows the hub's runs of these names in the run, live.
   */
  hubRefs: string[];
  stopRequested: boolean;
  /** Tests announced by Playwright's "Running N tests" lines, across steps. */
  progressTotal: number | null;
  /** Per-test result lines seen so far. */
  progressDone: number;
  /** The Piwi run this local process produced, once the reporter checked in: its first step's that reported. */
  piwiRunId: number | null;
  /** The Piwi run each step produced, by the step's name on the hub (`hubRefs`), once its reporter checked in. */
  piwiRunIds: Record<string, number>;
  /** Latest Piwi run id for the project at spawn: the run linked is newer, with this run's origin and reference. */
  piwiRunBaseline: number | null;
}

/** The label shown for the phase a reproduce/bisect run is in. */
const PHASE_LABEL: Record<LocalRunPhase, string> = {
  checkout: 'Checking out',
  install: 'Installing',
  browser: 'Installing browser',
  test: 'Testing',
  bisect: 'Bisecting',
  lab: 'Running the lab',
};

/**
 * Live label for a running run: how far it is as its own process counts it (`count`, `desktopRunProgress`), else the
 * tests Playwright's output announced and finished.
 */
export function localRunProgressLabel(run: LocalRun, count: DesktopRunCount | null = null): string {
  if (run.stopRequested) return 'Stopping…';
  if (run.kind === 'bisect' && run.bisect) {
    const { step, stepsEstimate, candidates } = run.bisect;
    const current = candidates.findLast((c) => c.verdict === 'testing');
    const short = current ? ` — ${current.sha.slice(0, 7)}` : '';
    if (step != null && stepsEstimate != null) return `Step ${step} of ~${stepsEstimate}${short} — testing…`;
    return `Bisecting${short}…`;
  }
  if (run.phase && run.phase !== 'test') return `${PHASE_LABEL[run.phase]}…`;
  if (count) return progressWords(count, englishRunSpeaker).join(' · ');
  if (run.progressTotal) return `Running ${run.progressDone}/${run.progressTotal}…`;
  return run.steps.length > 1 ? `Running ${run.stepIndex + 1}/${run.steps.length}…` : 'Running…';
}

/** `N tests`, or the test's title when there is one. */
function casesTitle(cases: readonly RetryCase[]): string {
  if (cases.length === 1 && cases[0]!.title) return cases[0]!.title;
  return `${cases.length} test${cases.length === 1 ? '' : 's'}`;
}

/** How long a run has run, or ran: `42s`, `3m 05s`. */
export function localRunDuration(startedAt: number, finishedAt: number | null, now: number): string {
  const seconds = Math.max(0, Math.round(((finishedAt ?? now) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** What a run runs, in words: the tray's row title, the toasts and the Run again tooltip read it. */
export function localRunTitle(
  run: Pick<LocalRun, 'kind' | 'title' | 'cases' | 'commit' | 'good' | 'bad' | 'flake'>,
): string {
  if (run.title) return run.title;
  switch (run.kind) {
    case 'reproduce':
      return run.commit
        ? `Reproduce ${casesTitle(run.cases)} at ${run.commit.slice(0, 7)}`
        : `Reproduce ${casesTitle(run.cases)}`;
    case 'bisect':
      return run.good && run.bad
        ? `Bisect ${casesTitle(run.cases)} between ${run.good.slice(0, 7)} and ${run.bad.slice(0, 7)}`
        : `Bisect ${casesTitle(run.cases)}`;
    case 'repro':
      return 'Bug report steps';
    case 'flake':
      return run.flake ? `Flake Lab on test #${run.flake.testCaseId}` : 'Flake Lab plan from your editor';
    default:
      return casesTitle(run.cases);
  }
}

/** A run's second line: its project, then the command its current step runs, when it has one. */
export function localRunDetail(run: Pick<LocalRun, 'projectLabel' | 'projectId' | 'steps' | 'stepIndex'>): string {
  const project = run.projectLabel || `Project ${run.projectId}`;
  const command = run.steps[run.stepIndex]?.display;
  return command ? `${project} · ${command}` : project;
}

/**
 * The Changes tab of the Piwi run a local run produced, against the run its tests come from, or null until it
 * reported or when it has no source run.
 */
export function localRunCompareTo(run: Pick<LocalRun, 'piwiRunId' | 'sourceRunId'>): string | null {
  if (run.piwiRunId == null || run.sourceRunId == null || run.piwiRunId === run.sourceRunId) return null;
  return `/test-runs/${run.piwiRunId}?tab=changes&baseline=${run.sourceRunId}`;
}

/** One key per set of cases, whatever their order: a button finds the runs of its own tests by it. */
function localRunCasesKey(cases: readonly RetryCase[]): string {
  return cases
    .map((c) => [c.filePath, c.line ?? '', c.projectName ?? '', c.title].join('\u0000'))
    .sort()
    .join('\n');
}

/**
 * The options that are not the defaults, in words (`by title · headed · ×20 · trace · hold failures`), or an empty string: a run button
 * appends them to its face, so what one click runs is never hidden in a menu.
 */
export function localRunOptionsSummary(options: LocalRunOptions): string {
  const parts: string[] = [];
  if (options.mode === 'grep') parts.push('by title');
  else if (options.mode === 'file') parts.push('whole files');
  if (options.runMode === 'headed') parts.push('headed');
  else if (options.runMode === 'debug') parts.push('inspector');
  else if (options.runMode === 'ui') parts.push('UI mode');
  if ((options.repeatEach ?? 1) > 1) {
    parts.push(stopsAtFirstFailure(options) ? `×${options.repeatEach} until a failure` : `×${options.repeatEach}`);
  }
  if (options.trace) parts.push('trace');
  if (localRunHoldsFailures(options)) parts.push('hold failures');
  return parts.join(' · ');
}

export const DEFAULT_LOCAL_RUN_OPTIONS: SavedLocalRunOptions = {
  mode: 'file-line',
  runMode: 'normal',
  trace: false,
  repeatEach: 1,
  stopAtFirstFailure: false,
  holdFailures: false,
};

export const LOCAL_RUN_MODE_ITEMS: { label: string; value: LocalRunMode; icon: string }[] = [
  { label: 'Headless', value: 'normal', icon: 'i-lucide-square-terminal' },
  { label: 'Headed', value: 'headed', icon: 'i-lucide-app-window' },
  { label: 'Debug (inspector)', value: 'debug', icon: 'i-lucide-bug' },
  { label: 'UI mode', value: 'ui', icon: 'i-lucide-layout-grid' },
];

export const RETRY_MODE_ITEMS: { label: string; value: RetryMode }[] = [
  { label: 'File:line', value: 'file-line' },
  { label: 'Title (grep)', value: 'grep' },
  { label: 'File only', value: 'file' },
];

/** A phase/step/verdict/result the shell streams for a reproduce or bisect run. */
interface BisectEventPayload {
  event: 'step' | 'verdict' | 'result';
  step?: number | null;
  stepsEstimate?: number | null;
  sha?: string | null;
  verdict?: BisectVerdict | null;
  firstBad?: BisectFirstBad | null;
}

interface LocalRunEventPayload {
  id: number;
  kind: 'stdout' | 'stderr' | 'error' | 'exit' | 'phase' | 'bisect' | 'repro' | 'lab';
  line: string | null;
  code: number | null;
  /** For kind === 'phase': which phase the run entered. */
  phase?: LocalRunPhase | null;
  /** For kind === 'bisect': the bisect progress event. */
  bisect?: BisectEventPayload | null;
  /** For kind === 'repro': what the repro spec recorded, or null. */
  repro?: SpecRunResult | null;
  /** For kind === 'lab': the report `piwi flake --json` printed, or null. */
  lab?: unknown;
}

/** Output lines kept per run — a soak run can produce hundreds of thousands. */
export const LOCAL_RUN_MAX_LINES = 2000;
/**
 * How long after a stop request a run's step counts as over even with no exit
 * event: the shell's grace period before it kills the process, plus a margin.
 */
const STOP_EXIT_FALLBACK_MS = 15_000;
/** Finished runs kept in the tray; running ones are never dropped. */
/** How long a run waits for its Piwi run baseline before it starts without one. */
const BASELINE_TIMEOUT_MS = 10_000;
const MAX_FINISHED = 15;
/** The names on the hub kept per run: one per step of its plan. */
const MAX_HUB_REFS = 20;
const OPTIONS_STORAGE_KEY = 'piwi:desktop-local-run-options';
/** Where a window keeps its runs across a reload of its page: its own session storage. */
const RELOAD_STORAGE_KEY = 'piwi:desktop-local-runs';
/** The output lines of each run a reload keeps: its last ones. */
const RELOAD_LINES = 300;

/** How far a run's step that ended came, as the hub last counted it (`endedProgress`, `endedAtStop`). */
interface KeptEnded {
  progress?: HubProgress;
  endedAtStop?: number;
}

/** What a page keeps for the next one, after a reload (`keepForReload`). */
interface KeptForReload {
  runs: LocalRun[];
  holds: Record<number, boolean>;
  separate: Record<number, boolean>;
  trayOpen: boolean;
  /** How far each step of the runs that ended came, by its name on the hub. */
  ended?: Record<string, KeptEnded>;
}

/**
 * The shell's runs as `desktop_local_runs` answers: those still going, the latest that ended, each with its code and
 * the events that carried its verdict (what a repro spec recorded, a lab's report, a bisect's result), and the origin
 * reference this window gave each plain run it started.
 */
interface ShellLocalRuns {
  running: number[];
  ended: Array<{ id: number; code: number | null; events?: LocalRunEventPayload[] }>;
  origins?: Array<{ id: number; originRef: string }>;
}

// Client-only plumbing shared by every composable instance. Runs are driven
// from event handlers after mount, so none of this exists on the server.
let nextKey = 1;
let unlisten: (() => void) | null = null;
let startingSteps = 0;
let pendingEvents: LocalRunEventPayload[] = [];
/** What the page before a reload kept, once read (`readKeptForReload`): null when it kept nothing. */
let keptRead = false;
let keptForNextPage: KeptForReload | null = null;
/** The page is going (`keepForReload` ran): each run that starts a step or ends from then on is kept again. */
let pageGone = false;
const runByShellId = new Map<number, LocalRun>();
const exitResolvers = new Map<number, (code: number | null) => void>();
/** Who hears each run's end (`onRunEnded`), before the tray can drop it. */
const endListeners = new Set<(run: LocalRun) => void>();
let toastApi: ReturnType<typeof useToast> | null = null;
let routerApi: ReturnType<typeof useRouter> | null = null;
let optionsLoaded = false;

// Playwright's list reporter, as the shell captures it (non-TTY), read without
// its colors: a "Running N tests using M workers" announcement per step, then
// one line per finished test starting with a result mark (✓/✘ or the ASCII
// fallbacks).
const PROGRESS_TOTAL_RE = /^Running (\d+) tests? using \d+ workers?$/;
const PROGRESS_RESULT_RE = /^\s{1,6}(?:✓|✘|✗|x|ok|-)\s+\d+\s/;

export function useDesktopLocalRuns() {
  const runs = useState<LocalRun[]>('desktop-local-runs', () => []);
  const trayOpen = useState<boolean>('desktop-local-runs-tray', () => false);
  /** A worker of a hub's run the tray is asked to show (`showWorker`), until the tray has shown it. */
  const shownWorker = useState<{ ref: string; worker: number } | null>('desktop-local-runs-shown-worker', () => null);
  const optionsByProject = useState<Record<string, SavedLocalRunOptions>>('desktop-local-run-options', () => ({}));
  /** Each run's Hold failures choice, by its key; unset falls back to how it started (`desktopHoldsByDefault`). */
  const holds = useState<Record<number, boolean>>('desktop-local-runs-holds', () => ({}));
  /** The runs whose output shows in a separate window instead of the tray, by key (`DesktopRunOutputWindows`). */
  const separate = useState<Record<number, boolean>>('desktop-local-runs-separate', () => ({}));
  /** The runs whose separate output window the page before a reload had open: it is asked for, never opened again. */
  const keptWindows = useState<number[]>('desktop-local-runs-kept-windows', () => []);
  /** How many Local runs trays are mounted: none on a page without the default layout (TV mode, an error page). */
  const trayMounts = useState<number>('desktop-local-runs-tray-mounts', () => 0);
  if (import.meta.client) {
    toastApi = useToast();
    routerApi = useRouter();
  }

  const activeCount = computed(() => runs.value.filter((r) => r.status === 'running').length);

  function loadOptions() {
    if (optionsLoaded || !import.meta.client) return;
    optionsLoaded = true;
    try {
      const raw = localStorage.getItem(OPTIONS_STORAGE_KEY);
      if (raw) optionsByProject.value = JSON.parse(raw);
    } catch {
      // Corrupt or unavailable storage — defaults apply.
    }
  }

  function getProjectOptions(projectId: string | number): SavedLocalRunOptions {
    loadOptions();
    return { ...DEFAULT_LOCAL_RUN_OPTIONS, ...optionsByProject.value[String(projectId)] };
  }

  function saveProjectOptions(projectId: string | number, patch: LocalRunOptions) {
    loadOptions();
    const next = { ...getProjectOptions(projectId), ...patch };
    optionsByProject.value = { ...optionsByProject.value, [String(projectId)]: next };
    try {
      localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(optionsByProject.value));
    } catch {
      // Storage full or unavailable — options just won't persist.
    }
  }

  function pushLine(run: LocalRun, printed: string, error: boolean) {
    const text = stripAnsi(printed);
    const id = ++run.linesTotal;
    run.lines.push(text === printed || !text ? { id, text, error } : { id, text, error, ansi: printed });
    if (run.lines.length > LOCAL_RUN_MAX_LINES) run.lines.splice(0, run.lines.length - LOCAL_RUN_MAX_LINES);
    if (error) return;
    const total = PROGRESS_TOTAL_RE.exec(text);
    if (total) {
      run.progressTotal = (run.progressTotal ?? 0) + Number(total[1]);
    } else if (PROGRESS_RESULT_RE.test(text)) {
      // Retried tests print extra result lines, so clamp to the announced total.
      run.progressDone = Math.min(run.progressDone + 1, run.progressTotal ?? run.progressDone + 1);
    }
  }

  function applyBisectEvent(run: LocalRun, ev: BisectEventPayload) {
    const state = (run.bisect ??= { step: null, stepsEstimate: null, candidates: [], firstBad: null });
    if (ev.event === 'step') {
      if (ev.step != null) state.step = ev.step;
      if (ev.stepsEstimate != null) state.stepsEstimate = ev.stepsEstimate;
      if (ev.sha) state.candidates.push({ sha: ev.sha, verdict: 'testing' });
    } else if (ev.event === 'verdict') {
      const target = ev.sha
        ? state.candidates.find((c) => c.sha === ev.sha)
        : state.candidates.findLast((c) => c.verdict === 'testing');
      if (target && ev.verdict) target.verdict = ev.verdict;
    } else if (ev.event === 'result' && ev.firstBad) {
      // A result a reload replays is recorded once.
      if (state.firstBad?.sha === ev.firstBad.sha) return;
      state.firstBad = ev.firstBad;
      void persistBisectResult(run, ev.firstBad);
    }
  }

  function dispatch(run: LocalRun, payload: LocalRunEventPayload) {
    if (payload.kind === 'exit') {
      exitResolvers.get(payload.id)?.(payload.code);
      return;
    }
    if (payload.kind === 'phase') {
      if (payload.phase) {
        run.phase = payload.phase;
        pushLine(run, `── ${PHASE_LABEL[payload.phase]} ──`, false);
      }
      return;
    }
    if (payload.kind === 'bisect') {
      if (payload.bisect) applyBisectEvent(run, payload.bisect);
      return;
    }
    if (payload.kind === 'repro') {
      if (run.repro) run.repro.result = payload.repro ?? null;
      return;
    }
    if (payload.kind === 'lab') {
      run.labReport = flakeLabJobReport(payload.lab);
      return;
    }
    pushLine(run, payload.line ?? '', payload.kind !== 'stdout');
  }

  async function ensureListener() {
    if (unlisten) return;
    const events = tauriEvent();
    if (!events) throw new Error('The desktop bridge is unavailable.');
    unlisten = await events.listen<LocalRunEventPayload>('piwi:local-run', ({ payload }) => {
      const run = runByShellId.get(payload.id);
      if (run) dispatch(run, payload);
      else if (startingSteps > 0) pendingEvents.push(payload);
    });
  }

  /**
   * Invoke a shell command that spawns a tracked process and streams
   * `piwi:local-run` events under a shell-assigned id, then resolve with its
   * exit code. Buffered events that arrived before the id was known are
   * replayed in the same tick the id is registered, so none can slip through.
   * Used for a test step (`desktop_run_local_tests`) and for the single
   * reproduce/bisect drivers alike.
   */
  async function spawnCommand(run: LocalRun, cmd: string, invokeArgs: Record<string, unknown>): Promise<number | null> {
    const core = tauriCore();
    if (!core) throw new Error('The desktop bridge is unavailable.');
    startingSteps += 1;
    run.stepStarting = true;
    if (pageGone) keepForReload();
    let shellId: number;
    try {
      shellId = await core.invoke<number>(cmd, invokeArgs);
    } catch (error) {
      startingSteps -= 1;
      run.stepStarting = false;
      throw error;
    }
    // Same tick as the invoke resolution: register the id, replay buffered
    // events for it, then release the buffer — no event can slip through.
    run.stepStarting = false;
    nameStep(run, shellId);
    const exit = adopt(run, shellId);
    releaseBuffer();
    if (pageGone) keepForReload();
    return exit;
  }

  /** The step the shell runs as process `shellId` gives the hub its name: the run's latest. */
  function nameStep(run: LocalRun, shellId: number) {
    run.hubRefs = [...run.hubRefs.filter((ref) => ref !== desktopRunRef(shellId)), desktopRunRef(shellId)].slice(
      -MAX_HUB_REFS,
    );
  }

  /**
   * Take the shell's process `shellId` as the run's step: its buffered events are replayed now, the next ones come to
   * the run, and the promise resolves with its exit code once it ends. Called in the tick the id became known.
   */
  function adopt(run: LocalRun, shellId: number): Promise<number | null> {
    const exit = new Promise<number | null>((resolve) => exitResolvers.set(shellId, resolve));
    runByShellId.set(shellId, run);
    run.shellId = shellId;
    const mine = pendingEvents.filter((p) => p.id === shellId);
    pendingEvents = pendingEvents.filter((p) => p.id !== shellId);
    for (const payload of mine) dispatch(run, payload);
    return exit.then((code) => {
      runByShellId.delete(shellId);
      exitResolvers.delete(shellId);
      run.shellId = null;
      return code;
    });
  }

  /** A start, or a reload's take-back, has its process's id: the buffer goes once none waits for one. */
  function releaseBuffer() {
    startingSteps -= 1;
    if (startingSteps === 0) pendingEvents = [];
  }

  /**
   * Drive a run to its end. `resumed`, for a run a reload took back, is the end of the step its process ran as the page
   * reloaded: the run goes on from there.
   */
  async function drive(run: LocalRun, resumed?: Promise<number | null>) {
    try {
      await ensureListener();
      let worst: number | null = null;
      if (run.kind === 'tests') worst = await driveTests(run, resumed);
      else if (resumed) worst = await resumed;
      else if (!run.stopRequested) worst = await driveSingle(run);
      if (run.stopRequested) {
        run.status = 'stopped';
      } else {
        run.exitCode = typeof worst === 'number' ? worst : 1;
        // A lab session that ran to a verdict has done its job, reproduced or not.
        const done = run.kind === 'flake' ? flakeLabOutcome(run.exitCode) !== 'error' : worst === 0;
        run.status = done ? 'passed' : 'failed';
      }
    } catch (error) {
      pushLine(run, errorMessage(error), true);
      run.status = 'error';
    } finally {
      if (run.kind === 'repro') await finishRepro(run);
      if (run.jobRequestId) await finishJob(run);
      run.finishedAt = Date.now();
      // Ended after the page kept its runs: the next page takes it back as ended, its verdict recorded.
      if (pageGone) keepForReload();
      for (const listener of endListeners) {
        try {
          listener(run);
        } catch {
          // One listener failing must not keep the run from ending.
        }
      }
      notifyFinished(run);
      trimFinished();
    }
  }

  /**
   * The multi-step test plan: one spawn per Playwright project, worst code wins. A run a reload took back goes on
   * after the step it ran (`resumed`).
   */
  async function driveTests(run: LocalRun, resumed?: Promise<number | null>): Promise<number | null> {
    const ended = (code: number | null) => {
      if (code !== 0) run.stepsExit = code ?? 1;
    };
    let first = 0;
    if (resumed) {
      const code = await resumed;
      if (!run.stopRequested) ended(code);
      first = run.stepIndex + 1;
    }
    for (const [index, step] of run.steps.entries()) {
      if (index < first) continue;
      if (run.stopRequested) break;
      run.stepIndex = index;
      if (run.steps.length > 1) pushLine(run, `$ ${step.display}`, false);
      const code = await spawnCommand(run, 'desktop_run_local_tests', {
        projectId: run.projectId,
        args: step.args,
        originRef: run.originRef,
      });
      if (run.stopRequested) break;
      ended(code);
    }
    return run.stepsExit;
  }

  /**
   * A reproduce or bisect run: one shell driver that owns the whole worktree
   * lifecycle (checkout · install · browser · test, or the bisect loop) and
   * streams phase, output and bisect events under a single id.
   */
  async function driveSingle(run: LocalRun): Promise<number | null> {
    if (run.kind === 'repro' && run.repro) {
      return spawnCommand(run, 'desktop_run_repro', {
        projectId: run.projectId,
        requestId: run.repro.requestId,
        args: run.repro.args,
        bugReportId: run.repro.bugReportId ?? null,
        originRef: run.originRef,
      });
    }
    if (run.kind === 'request' && run.teamRequest) {
      // Only the request: the shell takes its command and its request token from this app's server.
      return spawnCommand(run, 'desktop_run_requested_tests', { requestId: run.teamRequest.id });
    }
    if (run.kind === 'flake' && run.jobRequestId) {
      // Only the request: the shell reads its commit and plan from this app's
      // server, writes the plan file and builds the command itself.
      return spawnCommand(run, 'desktop_flake_lab_job', {
        projectId: run.projectId,
        requestId: run.jobRequestId,
      });
    }
    if (run.kind === 'flake' && run.flake) {
      // Only the test and the options: the shell reads the commit, builds the
      // command and its environment itself.
      const { suspect, all, runs, budgetMinutes } = run.flake.options;
      return spawnCommand(run, 'desktop_flake_lab_here', {
        testCaseId: run.flake.testCaseId,
        suspect,
        all,
        runs,
        budgetMinutes,
      });
    }
    if (run.kind === 'bisect') {
      return spawnCommand(run, 'desktop_bisect_here', {
        projectId: run.projectId,
        good: run.good,
        bad: run.bad,
        browser: run.browserName,
        args: buildBisectArgs(run.cases),
        flakeTestCaseId: run.flakeTestCaseId,
        clusterId: run.bisectTarget?.clusterId ?? null,
        originRef: run.originRef,
      });
    }
    return spawnCommand(run, 'desktop_reproduce_here', {
      projectId: run.projectId,
      commit: run.commit,
      browser: run.browserName,
      args: buildReproduceArgs(run.cases),
      clusterId: run.clusterId ?? null,
      originRef: run.originRef,
    });
  }

  /**
   * Read a repro run's verdict from what its spec recorded, against the lines
   * each step starts on, and record it on the request, where Piwi Picker reads
   * it. A run that could not start is recorded as stopped.
   */
  async function finishRepro(run: LocalRun) {
    const repro = run.repro;
    if (!repro) return;
    let verdict: SpecRunVerdict = { kind: 'stopped' };
    if (repro.result && run.status !== 'stopped') {
      try {
        const spec = await $fetch<{ stepLines: number[] }>(
          `/api/desktop/repro-requests/${repro.requestId}/spec?projectId=${run.projectId}`,
        );
        verdict = specRunVerdict(repro.steps.steps, spec.stepLines, repro.result);
      } catch {
        verdict = specRunVerdict(repro.steps.steps, [], repro.result);
      }
    }
    repro.verdict = verdict;
    try {
      await $fetch(`/api/desktop/repro-requests/${repro.requestId}`, {
        method: 'PATCH',
        body: { status: 'done', verdict, runId: run.piwiRunId ?? undefined },
      });
    } catch {
      // The request expired meanwhile; the tray still shows the verdict.
    }
  }

  /** Record a job run's verdict on the request, where the editor that sent it reads it. */
  async function finishJob(run: LocalRun) {
    try {
      await $fetch(`/api/desktop/repro-requests/${run.jobRequestId}`, {
        method: 'PATCH',
        body: { status: 'done', jobVerdict: desktopJobVerdict(run), runId: run.piwiRunId ?? undefined },
      });
    } catch {
      // The request expired meanwhile; the tray still shows the result.
    }
  }

  function notifyFinished(run: LocalRun) {
    if (run.status === 'stopped') return;
    if (run.kind === 'repro') {
      const verdict = reproVerdictText(run.repro?.verdict ?? null);
      notifyUnfocused(run, run.projectLabel || 'Repro', verdict.label, 0);
      toastApi?.add({
        title: verdict.label,
        description: verdict.detail,
        icon: 'i-lucide-bug',
        color: verdict.color === 'neutral' ? 'neutral' : verdict.color,
        actions: [
          {
            label: 'View output',
            color: 'neutral' as const,
            variant: 'outline' as const,
            onClick: () => {
              trayOpen.value = true;
            },
          },
        ],
      });
      return;
    }
    const label = run.projectLabel || 'Local run';
    const seconds = Math.max(1, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
    const viewOutputAction = {
      label: 'View output',
      color: 'neutral' as const,
      variant: 'outline' as const,
      onClick: () => {
        trayOpen.value = true;
      },
    };
    if (run.kind === 'flake') {
      const outcome = flakeLabOutcome(run.exitCode);
      const title =
        outcome === 'reproduced'
          ? 'The lab reproduced the flake'
          : outcome === 'not-reproduced'
            ? 'The lab did not reproduce the flake'
            : 'Flake Lab could not run';
      notifyUnfocused(run, label, title, seconds);
      const lands = run.jobRequestId
        ? 'Your editor can share the results on its instance.'
        : "The experiment is on the test's Flakiness tab.";
      toastApi?.add({
        title,
        description:
          outcome === 'error'
            ? (run.lines.findLast((l) => l.error)?.text ?? `Stopped after ${seconds}s`)
            : `${label} — ${seconds}s. ${lands}`,
        icon: 'i-lucide-flask-conical',
        color: outcome === 'reproduced' ? 'success' : outcome === 'error' ? 'error' : 'neutral',
        actions: [viewOutputAction],
      });
      return;
    }
    if (run.kind === 'bisect') {
      const found = run.bisect?.firstBad;
      if (found) {
        notifyUnfocused(run, label, `first bad commit ${found.sha.slice(0, 7)}`, seconds);
        toastApi?.add({
          title: 'Bisect found the breaking commit',
          description: `${found.sha.slice(0, 7)} — ${found.subject}`,
          icon: 'i-lucide-git-commit-horizontal',
          color: 'success',
          actions: [viewOutputAction],
        });
      } else {
        toastApi?.add({
          title: 'Bisect did not finish',
          description: run.lines.findLast((l) => l.error)?.text ?? `Stopped after ${seconds}s`,
          icon: 'i-lucide-triangle-alert',
          color: 'error',
          actions: [viewOutputAction],
        });
      }
      return;
    }
    const tests = localRunTitle(run);
    notifyUnfocused(run, label, tests, seconds);
    const viewOutput = {
      label: 'View output',
      color: 'neutral' as const,
      variant: 'outline' as const,
      onClick: () => {
        trayOpen.value = true;
      },
    };
    const compareTo = localRunCompareTo(run);
    const openPiwiRun =
      run.piwiRunId == null
        ? []
        : [
            compareTo
              ? {
                  label: `Compare with run #${run.sourceRunId}`,
                  color: 'neutral' as const,
                  variant: 'outline' as const,
                  onClick: () => {
                    void routerApi?.push(compareTo);
                  },
                }
              : {
                  label: `Open run #${run.piwiRunId}`,
                  color: 'neutral' as const,
                  variant: 'outline' as const,
                  onClick: () => {
                    void routerApi?.push(`/test-runs/${run.piwiRunId}`);
                  },
                },
          ];
    if (run.status === 'failed' && run.piwiRunId != null) {
      // A failed run's end leads to its failure, its run's page when none can be named.
      const openFailure = {
        label: 'Open the failure',
        color: 'neutral' as const,
        variant: 'outline' as const,
        onClick: () => {
          void failurePage(run).then((page) => routerApi?.push(page));
        },
      };
      toastApi?.add({
        title: 'Local run failed',
        description: `${label} — ${tests}: exit ${run.exitCode ?? 1} after ${seconds}s`,
        icon: 'i-lucide-x',
        color: 'error',
        actions: [viewOutput, openFailure],
      });
    } else if (run.status === 'passed') {
      toastApi?.add({
        title: 'Local run passed',
        description: `${label} — ${tests} in ${seconds}s`,
        icon: 'i-lucide-check',
        color: 'success',
        actions: [viewOutput, ...openPiwiRun],
      });
    } else if (run.status === 'failed') {
      toastApi?.add({
        title: 'Local run failed',
        description: `${label} — ${tests}: exit ${run.exitCode ?? 1} after ${seconds}s`,
        icon: 'i-lucide-x',
        color: 'error',
        actions: [viewOutput, ...openPiwiRun],
      });
    } else {
      toastApi?.add({
        title: 'Local run could not start',
        description: run.lines.findLast((l) => l.error)?.text,
        icon: 'i-lucide-triangle-alert',
        color: 'error',
        actions: [viewOutput],
      });
    }
  }

  /**
   * A headless run can take minutes — when the window is hidden or unfocused,
   * also raise an OS notification. Inside the shell, `window.Notification` is
   * shimmed onto native notifications by the desktop plugin, and the shell
   * counts them on the dock/taskbar unread badge.
   */
  function notifyUnfocused(run: LocalRun, label: string, tests: string, seconds: number) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return;
    const title =
      run.status === 'passed'
        ? 'Local run passed'
        : run.status === 'failed'
          ? 'Local run failed'
          : 'Local run could not start';
    const body =
      run.status === 'failed'
        ? `${label} — ${tests}: exit ${run.exitCode ?? 1} after ${seconds}s`
        : `${label} — ${tests} in ${seconds}s`;
    try {
      new Notification(title, { body });
    } catch {
      // Notifications unavailable in this webview — the toast still shows.
    }
  }

  function trimFinished() {
    const finished = runs.value.filter((r) => r.status !== 'running');
    if (finished.length <= MAX_FINISHED) return;
    const drop = new Set(finished.slice(MAX_FINISHED).map((r) => r.key));
    runs.value = runs.value.filter((r) => !drop.has(r.key));
  }

  /**
   * Build the plan from the given cases and spawn it, with the given options on
   * top of the project's defaults (which it never changes). Returns the tracked
   * run, or `null` when there is nothing to spawn.
   */
  function startRun(input: {
    projectId: string | number;
    projectLabel?: string | null;
    cases: RetryCase[];
    /** What the run runs, in words (`localRunTitle`). */
    title?: string | null;
    /** The Piwi run the cases come from. */
    sourceRunId?: number | null;
    options?: LocalRunOptions;
  }): LocalRun | null {
    if (!tauriCore() || input.cases.length === 0) return null;
    const options = { ...getProjectOptions(input.projectId), ...input.options };
    const steps = buildLocalRunPlan(input.cases, options);
    if (steps.length === 0) return null;
    return spawn({
      kind: 'tests',
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      cases: input.cases,
      title: input.title,
      sourceRunId: input.sourceRunId,
      options,
      steps,
    });
  }

  /**
   * Create a tracked run of any kind, insert it and start driving it. The
   * reactive proxy the array returns is what every mutation goes through, so the
   * tray and button render it live. Returns the tracked run.
   */
  function spawn(input: {
    kind: LocalRunKind;
    projectId: string | number;
    projectLabel?: string | null;
    cases: RetryCase[];
    title?: string | null;
    sourceRunId?: number | null;
    options: SavedLocalRunOptions;
    steps: LocalRunStep[];
    browserName?: string | null;
    commit?: string | null;
    clusterId?: number | null;
    good?: string | null;
    bad?: string | null;
    bisectTarget?: BisectTarget | null;
    repro?: ReproRunState | null;
    flake?: FlakeLabRunState | null;
    flakeTestCaseId?: number | null;
    jobRequestId?: string | null;
    teamRequest?: { id: string; instance: string } | null;
  }): LocalRun {
    // A run that starts before the page took back the runs of the page before takes a key none of them has.
    readKeptForReload();
    // What the shell stamps as the reference: the cluster or bug report a run was launched for wins.
    const named = input.clusterId ?? input.bisectTarget?.clusterId ?? input.repro?.bugReportId ?? null;
    const originRef =
      named != null
        ? String(named)
        : input.jobRequestId
          ? `job:${input.jobRequestId}`
          : input.repro
            ? `repro:${input.repro.requestId}`
            : newLocalRunRef(input.kind === 'tests' ? 'desktop' : input.kind);
    const run: LocalRun = {
      key: nextKey++,
      kind: input.kind,
      projectId: String(input.projectId),
      projectLabel: input.projectLabel ?? null,
      cases: input.cases.map((c) => ({ ...c })),
      title: input.title ?? null,
      sourceRunId: input.sourceRunId ?? null,
      options: input.options,
      steps: input.steps,
      stepIndex: 0,
      stepsExit: 0,
      phase: null,
      browserName: input.browserName ?? null,
      commit: input.commit ?? null,
      clusterId: input.clusterId ?? null,
      good: input.good ?? null,
      bad: input.bad ?? null,
      bisect: input.kind === 'bisect' ? { step: null, stepsEstimate: null, candidates: [], firstBad: null } : null,
      bisectTarget: input.bisectTarget ?? null,
      repro: input.repro ?? null,
      flake: input.flake ?? null,
      labReport: null,
      flakeTestCaseId: input.flakeTestCaseId ?? null,
      jobRequestId: input.jobRequestId ?? null,
      teamRequest: input.teamRequest ?? null,
      originRef,
      status: 'running',
      lines: [],
      linesTotal: 0,
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      shellId: null,
      stepStarting: false,
      hubRefs: [],
      stopRequested: false,
      progressTotal: null,
      progressDone: 0,
      piwiRunId: null,
      piwiRunIds: {},
      piwiRunBaseline: null,
    };
    runs.value = [run, ...runs.value];
    const tracked = runs.value[0]!;
    trayOpen.value = true;
    if (localRunOriginKind(tracked.kind)) void captureBaseline(tracked).then(() => drive(tracked));
    else {
      // A Flake Lab session, which no Piwi run is linked to, starts at once: its lab runs begin once its worktree is
      // checked out and installed, and the baseline its stop takes them off the OS progress by is taken meanwhile. A
      // run a team instance asked for reports there, so no run of this app's server is its baseline.
      if (tracked.kind !== 'request') void captureBaseline(tracked);
      void drive(tracked);
    }
    return tracked;
  }

  /**
   * Reproduce a failure end to end against the linked folder: the shell checks
   * out the failing commit in a throwaway worktree, installs, installs the
   * browser and runs exactly the failing test(s) — the user's checkout is never
   * touched. Returns the tracked run, or `null` when there is nothing to run.
   */
  function startReproduce(input: {
    projectId: string | number | null | undefined;
    projectLabel?: string | null;
    cases: RetryCase[];
    commit: string;
    browserName?: string | null;
    /** The failure cluster reproduced, recorded as the run's origin reference. */
    clusterId?: number | null;
    /** The editor's job this run answers. */
    jobRequestId?: string | null;
  }): LocalRun | null {
    if (!tauriCore() || input.projectId == null || input.cases.length === 0) return null;
    return spawn({
      kind: 'reproduce',
      jobRequestId: input.jobRequestId ?? null,
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      cases: input.cases,
      options: { ...DEFAULT_LOCAL_RUN_OPTIONS },
      steps: [],
      commit: input.commit,
      clusterId: input.clusterId ?? null,
      browserName: input.browserName ?? null,
    });
  }

  /**
   * Drive a git bisect over the regression window in a throwaway worktree — the
   * shell steps commit by commit (install, run, good/bad) and names the first
   * bad commit, which is persisted on the cluster. Returns the tracked run, or
   * `null` when there is nothing to bisect.
   */
  function startBisect(input: {
    projectId: string | number | null | undefined;
    projectLabel?: string | null;
    cases: RetryCase[];
    good: string;
    bad: string;
    browserName?: string | null;
    target?: BisectTarget | null;
    /** Run this test's reproducing Flake Lab arm at each step instead of the plain test. */
    flakeTestCaseId?: number | null;
    /** The editor's job this run answers. */
    jobRequestId?: string | null;
  }): LocalRun | null {
    if (!tauriCore() || input.projectId == null || input.cases.length === 0) return null;
    return spawn({
      kind: 'bisect',
      jobRequestId: input.jobRequestId ?? null,
      flakeTestCaseId: input.flakeTestCaseId ?? null,
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      cases: input.cases,
      options: { ...DEFAULT_LOCAL_RUN_OPTIONS },
      steps: [],
      good: input.good,
      bad: input.bad,
      browserName: input.browserName ?? null,
      bisectTarget: input.target ?? null,
    });
  }

  /**
   * Run a Flake Lab session on one test in the desktop app: the shell checks
   * out the commit of its latest failure in a throwaway worktree, installs,
   * and runs `piwi flake` there, streaming its output. The experiment is
   * recorded on the test like one from the command line. Returns the tracked
   * run, or `null` outside the desktop app.
   */
  function startFlakeLab(input: {
    projectId: string | number | null | undefined;
    projectLabel?: string | null;
    testCaseId: number;
    options: FlakeLabOptions;
  }): LocalRun | null {
    if (!tauriCore() || input.projectId == null) return null;
    return spawn({
      kind: 'flake',
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      cases: [],
      options: { ...DEFAULT_LOCAL_RUN_OPTIONS },
      steps: [{ args: [], display: flakeLabDisplay(input.testCaseId, input.options) }],
      flake: { testCaseId: input.testCaseId, options: { ...input.options } },
    });
  }

  /**
   * Record a bisect result on the cluster it belongs to, so it survives a reload
   * and reaches the fix plan. When the execution has no cluster the result stays
   * in the tray only. Best-effort — a failed write leaves the tray result intact.
   */
  async function persistBisectResult(run: LocalRun, firstBad: BisectFirstBad) {
    const clusterId = run.bisectTarget?.clusterId;
    if (clusterId == null) return;
    try {
      await $fetch(`/api/failure-clusters/${clusterId}/bisect`, {
        method: 'POST',
        body: { sha: firstBad.sha, subject: firstBad.subject, author: firstBad.author, date: firstBad.date },
      });
    } catch {
      // The tray still shows the result; the next bisect can record it again.
    }
  }

  /**
   * Record the project's newest Piwi run id. `spawn` awaits it before starting
   * the process, so the run this local process produces (the reporter finds the
   * app via `~/.piwi/desktop.json`) is newer than the baseline; a Flake Lab
   * session does not wait for it. A lookup that fails or takes longer than
   * `BASELINE_TIMEOUT_MS` leaves no baseline: the run starts, without a Piwi
   * link.
   */
  async function captureBaseline(run: LocalRun) {
    try {
      const latest = await $fetch<{ id: number } | null>(`/api/projects/${run.projectId}/latest-run`, {
        timeout: BASELINE_TIMEOUT_MS,
      });
      run.piwiRunBaseline = latest?.id ?? 0;
    } catch {
      // Unknown baseline — this run just won't get a Piwi link.
    }
  }

  /**
   * Match local processes to the Piwi runs they produced: for each step, the
   * newest run the reporter recorded with this run's origin and reference,
   * newer than the baseline, under the name the step gave the run (`hubRefs`,
   * which the reporter records from `PIWI_RUN_REF`; `piwiRunIds`), the first
   * step's that reported being the run's (`piwiRunId`). Runs going at once for
   * the same cluster, bug report or job share the reference and never take each
   * other's: each finds its own by name, and a run the reporter recorded no name
   * for is linked, as the whole run's, only to a local run no other one with
   * that reference overlaps. Driven by the shared SSE stream (the tray
   * subscribes), so the link appears as soon as the reporter checks in.
   */
  async function correlatePiwiRuns() {
    const until = (run: LocalRun) => run.finishedAt ?? Date.now();
    const sharesReference = (a: LocalRun, b: LocalRun) =>
      a.projectId === b.projectId &&
      a.originRef === b.originRef &&
      localRunOriginKind(a.kind) === localRunOriginKind(b.kind) &&
      a.startedAt <= until(b) &&
      b.startedAt <= until(a);
    const cutoff = Date.now() - 2 * 60_000;
    for (const run of runs.value) {
      const baseline = run.piwiRunBaseline;
      if (baseline == null) continue;
      if (run.status !== 'running' && (run.finishedAt ?? 0) < cutoff) continue;
      const origin = localRunOriginKind(run.kind);
      if (!origin || !run.originRef) continue;
      run.piwiRunIds ??= {};
      const linkedSteps = Object.keys(run.piwiRunIds).length;
      // A run linked as a whole (its reporter named none) is done; else each step not linked yet is looked up.
      if (run.piwiRunId != null && linkedSteps === 0) continue;
      const steps = run.hubRefs.length > 0 ? run.hubRefs.filter((ref) => run.piwiRunIds[ref] == null) : [null];
      for (const step of steps) {
        const names = step ? [step, `${step}${UNATTENDED_RUN_SUFFIX}`] : [];
        try {
          const latest = await $fetch<{ id: number; name?: string | null } | null>(
            `/api/projects/${run.projectId}/latest-run`,
            {
              query: names.length > 0 ? { origin, ref: run.originRef, run: names } : { origin, ref: run.originRef },
            },
          );
          if (!latest || latest.id <= baseline) continue;
          if (latest.name == null) {
            if (run.piwiRunId != null || runs.value.some((other) => other !== run && sharesReference(other, run))) {
              continue;
            }
            run.piwiRunId = latest.id;
            break;
          }
          run.piwiRunIds = { ...run.piwiRunIds, [desktopRunOf(latest.name)]: latest.id };
          run.piwiRunId ??= latest.id;
        } catch {
          // Server briefly unavailable — the next stream event retries.
        }
      }
    }
  }

  /**
   * Run a repro request the developer confirmed: the shell renders its steps
   * as a spec in the project's test directory, runs it and removes it. The
   * request is marked running here and done, with its verdict, when it ends.
   */
  /**
   * Run a request a team instance sent, after **Run** in its confirmation: the shell starts it in the folder linked
   * to its project for that instance, and the run reports to that instance.
   */
  function startTeamRequest(input: {
    requestId: string;
    instance: string;
    projectId: number;
    projectName?: string | null;
    cases: RetryCase[];
    title: string;
  }): LocalRun | null {
    if (!tauriCore()) return null;
    const host = teamInstanceHost(input.instance);
    return spawn({
      kind: 'request',
      projectId: input.projectId,
      projectLabel: input.projectName ? `${input.projectName} on ${host}` : host,
      cases: input.cases,
      title: input.title,
      options: { ...DEFAULT_LOCAL_RUN_OPTIONS },
      steps: [],
      teamRequest: { id: input.requestId, instance: input.instance },
    });
  }

  async function startRepro(input: {
    projectId: string | number;
    projectLabel?: string | null;
    requestId: string;
    steps: PiwiSteps;
    args: string[];
    /** The bug report the request came from, recorded as the run's origin reference. */
    bugReportId?: number | null;
  }): Promise<LocalRun | null> {
    if (!tauriCore()) return null;
    await $fetch(`/api/desktop/repro-requests/${input.requestId}`, {
      method: 'PATCH',
      body: { status: 'running', projectId: Number(input.projectId) },
    });
    const display = ['playwright test', `piwi-repro/bug-${input.requestId}.spec.ts`, ...input.args].join(' ');
    return spawn({
      kind: 'repro',
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      cases: [],
      options: { ...DEFAULT_LOCAL_RUN_OPTIONS },
      steps: [{ args: input.args, display }],
      repro: {
        requestId: input.requestId,
        steps: input.steps,
        args: input.args,
        bugReportId: input.bugReportId ?? null,
        result: null,
        verdict: null,
      },
    });
  }

  /**
   * Run an editor's job the developer confirmed: reproduce the failing tests at
   * the job's commit, bisect between its good and failing commits, or run its
   * Flake Lab plan at the commit, in the linked folder. The request is marked
   * running here and done, with its verdict, when the run ends. The result is
   * the editor's to share: it never reaches a cluster or a test here, whose ids
   * belong to the instance the job came from.
   */
  async function startJob(input: {
    projectId: string | number;
    projectLabel?: string | null;
    request: ReproRequestView;
  }): Promise<LocalRun | null> {
    const job = input.request.job;
    if (!tauriCore() || !job) return null;
    await $fetch(`/api/desktop/repro-requests/${input.request.id}`, {
      method: 'PATCH',
      body: { status: 'running', projectId: Number(input.projectId) },
    });
    if (input.request.kind === 'flake-lab') {
      return spawn({
        kind: 'flake',
        jobRequestId: input.request.id,
        projectId: input.projectId,
        projectLabel: input.projectLabel,
        cases: [],
        options: { ...DEFAULT_LOCAL_RUN_OPTIONS },
        steps: [{ args: [], display: FLAKE_LAB_JOB_DISPLAY }],
      });
    }
    const common = {
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      cases: job.tests,
      browserName: job.browser,
      jobRequestId: input.request.id,
    };
    return input.request.kind === 'bisect' && job.good
      ? startBisect({ ...common, good: job.good, bad: job.commit })
      : startReproduce({ ...common, commit: job.commit });
  }

  /** Run a run again as it ran: what it runs, its options, and this window's Hold failures choice on it. */
  function rerun(run: LocalRun): LocalRun | null {
    const keepHold = (next: LocalRun | null) => {
      const chosen = holds.value[run.key];
      if (next && chosen !== undefined) holds.value = { ...holds.value, [next.key]: chosen };
      return next;
    };
    if (run.kind === 'repro' && run.repro) {
      const { requestId, steps, args, bugReportId } = run.repro;
      void startRepro({
        projectId: run.projectId,
        projectLabel: run.projectLabel,
        requestId,
        steps,
        args,
        bugReportId,
      })
        .then(keepHold)
        .catch((error) =>
          toastApi?.add({ title: 'Could not run again', description: errorMessage(error), color: 'error' }),
        );
      return null;
    }
    return keepHold(startAgain(run));
  }

  function startAgain(run: LocalRun): LocalRun | null {
    // Re-running repeats the run exactly.
    if (run.kind === 'reproduce' && run.commit) {
      return startReproduce({
        projectId: run.projectId,
        projectLabel: run.projectLabel,
        cases: run.cases,
        commit: run.commit,
        browserName: run.browserName,
        clusterId: run.clusterId,
      });
    }
    if (run.kind === 'bisect' && run.good && run.bad) {
      return startBisect({
        projectId: run.projectId,
        projectLabel: run.projectLabel,
        cases: run.cases,
        good: run.good,
        bad: run.bad,
        browserName: run.browserName,
        target: run.bisectTarget,
        flakeTestCaseId: run.flakeTestCaseId,
      });
    }
    // An editor's plan runs once: its experiment is the editor's to share.
    if (run.kind === 'flake' && !run.flake) return null;
    if (run.kind === 'flake' && run.flake) {
      return startFlakeLab({
        projectId: run.projectId,
        projectLabel: run.projectLabel,
        testCaseId: run.flake.testCaseId,
        options: run.flake.options,
      });
    }
    return startRun({
      projectId: run.projectId,
      projectLabel: run.projectLabel,
      cases: run.cases,
      title: run.title,
      sourceRunId: run.sourceRunId,
      options: run.options,
    });
  }

  /**
   * Stop a run as Ctrl+C would: the shell asks the process to wind down, so
   * Playwright reports the run as interrupted, and kills it after a grace
   * period. The run stays `running` (labelled "Stopping…") until the process
   * exits; calling this again kills it at once.
   */
  async function stopRun(run: LocalRun) {
    if (run.status !== 'running') return;
    run.stopRequested = true;
    const core = tauriCore();
    const shellId = run.shellId;
    if (core && shellId != null) {
      try {
        await core.invoke('desktop_stop_local_tests', { runId: shellId });
      } catch {
        // The process already exited between the check and the stop.
      }
      // Unblock the awaited step even if no exit event ever arrives.
      setTimeout(() => exitResolvers.get(shellId)?.(null), STOP_EXIT_FALLBACK_MS);
    }
  }

  /**
   * Write the window's runs to its session storage as its page goes, for the next page to take back
   * (`takeBackAfterReload`): each run with its last `RELOAD_LINES` output lines, else without its lines when the
   * storage is full, its Hold failures, whether its output is in a separate window, and how far each of its steps
   * that ended came. From then on, a run that starts a step or ends writes them again, so the next page goes on from
   * where this one left off.
   */
  function keepForReload() {
    pageGone = true;
    const ended = endedOfRuns();
    const kept = (lines: number): KeptForReload => ({
      runs: runs.value.map((run) => ({ ...run, lines: lines > 0 ? run.lines.slice(-lines) : [] })),
      holds: holds.value,
      separate: separate.value,
      trayOpen: trayOpen.value,
      ended,
    });
    for (const lines of [RELOAD_LINES, 0]) {
      try {
        sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify(kept(lines)));
        return;
      } catch {
        // Full or unavailable storage: tried again without the output, else the next page starts empty.
      }
    }
  }

  /** How far each step of the window's runs that ended came, as the hub counted it, by the step's name on the hub. */
  function endedOfRuns(): Record<string, KeptEnded> {
    const kept: Record<string, KeptEnded> = {};
    let state: { endedProgress: Record<string, HubProgress>; endedAtStop: Record<string, number> };
    try {
      state = useDesktopRunHub().state;
    } catch {
      return kept;
    }
    for (const run of runs.value) {
      for (const ref of run.hubRefs.flatMap((name) => [name, `${name}${UNATTENDED_RUN_SUFFIX}`])) {
        const progress = state.endedProgress[ref];
        const endedAtStop = state.endedAtStop[ref];
        if (progress || endedAtStop)
          kept[ref] = { ...(progress ? { progress } : {}), ...(endedAtStop ? { endedAtStop } : {}) };
      }
    }
    return kept;
  }

  /**
   * Read what the page before a reload kept (`keepForReload`), once, as the page starts, before any run can start:
   * the entry leaves the session storage at once, and a run this page starts takes a key none of those runs has.
   */
  function readKeptForReload() {
    if (keptRead) return;
    keptRead = true;
    try {
      const raw = sessionStorage.getItem(RELOAD_STORAGE_KEY);
      sessionStorage.removeItem(RELOAD_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as KeptForReload) : null;
      if (parsed && Array.isArray(parsed.runs)) keptForNextPage = parsed;
    } catch {
      // Unavailable or unreadable storage: the page starts with no run.
    }
    if (keptForNextPage) nextKey = Math.max(nextKey, ...keptForNextPage.runs.map((run) => run.key + 1));
  }

  /** Drop what a page kept for the next one: the page that kept it shows again, as it was. */
  function forgetKeptForReload() {
    pageGone = false;
    try {
      sessionStorage.removeItem(RELOAD_STORAGE_KEY);
    } catch {
      // Unavailable storage: nothing was kept.
    }
  }

  /**
   * Take back the runs the page before kept (`keepForReload`), once: those that had ended as they were, and each
   * running one where the shell has it: a step whose process still runs is followed again, one that ended meanwhile
   * ends with its exit code, its output and its verdict, and the run goes on from there; a step the shell was starting
   * as the page reloaded is found by the run's origin reference. A run whose process the shell does not know ends,
   * saying so. Then every run output window no run of this page shows in closes.
   */
  async function takeBackAfterReload() {
    readKeptForReload();
    const kept = keptForNextPage;
    keptForNextPage = null;
    if (kept && kept.runs.length > 0) await takeBack(kept);
    await closeUnownedOutputWindows();
  }

  async function takeBack(kept: KeptForReload) {
    const keys = new Set(runs.value.map((run) => run.key));
    const back = kept.runs.filter((run) => !keys.has(run.key));
    runs.value = [...runs.value, ...back];
    holds.value = { ...kept.holds, ...holds.value };
    separate.value = { ...kept.separate, ...separate.value };
    keptWindows.value = Object.entries(kept.separate)
      .filter(([, on]) => on)
      .map(([key]) => Number(key));
    if (kept.trayOpen) trayOpen.value = true;
    if (kept.ended) {
      try {
        useDesktopRunHub().takeBackEnded(kept.ended);
      } catch {
        // No hub: the runs show their own counts.
      }
    }
    const running = runs.value.filter((run) => back.some((k) => k.key === run.key) && run.status === 'running');
    if (running.length === 0) return;
    // Events of a process no run holds yet wait while the shell is asked, as they do while a step starts.
    startingSteps += 1;
    let shell: ShellLocalRuns | null = null;
    try {
      await ensureListener();
      shell = (await tauriCore()?.invoke<ShellLocalRuns>('desktop_local_runs')) ?? null;
    } catch {
      // The shell does not answer: no process can be followed again.
    }
    for (const run of running) {
      run.piwiRunIds ??= {};
      let id = run.shellId;
      if (id == null && run.stepStarting && shell) id = startedStep(run, shell);
      run.stepStarting = false;
      const ended = shell?.ended.find((end) => end.id === id);
      let resumed: Promise<number | null>;
      if (id != null && ended) {
        nameStep(run, id);
        replayEnded(run, id, ended.events ?? []);
        run.shellId = null;
        resumed = Promise.resolve(ended.code);
      } else if (id != null && shell?.running.includes(id)) {
        nameStep(run, id);
        resumed = adopt(run, id);
      } else {
        run.shellId = null;
        resumed = Promise.reject(new Error('The window reloaded as this run started, and lost it: run it again.'));
      }
      void drive(run, resumed);
    }
    releaseBuffer();
  }

  /**
   * The process of the step a run was starting as the page reloaded: the newest one the shell started with the run's
   * origin reference that is none of its steps' yet; null when the shell started none.
   */
  function startedStep(run: LocalRun, shell: ShellLocalRuns): number | null {
    const known = new Set(run.hubRefs.map(desktopShellIdOf));
    const ids = (shell.origins ?? [])
      .filter((origin) => origin.originRef === run.originRef && !known.has(origin.id))
      .map((origin) => origin.id);
    return ids.length > 0 ? Math.max(...ids) : null;
  }

  /**
   * A step that ended while the page reloaded: the events of its process that came while the shell was asked, then
   * those that carried its verdict the shell kept with its end and the page did not hear, each once.
   */
  function replayEnded(run: LocalRun, id: number, verdicts: LocalRunEventPayload[]) {
    const mine = pendingEvents.filter((p) => p.id === id);
    pendingEvents = pendingEvents.filter((p) => p.id !== id);
    const heard = new Set(mine.map((payload) => JSON.stringify(payload)));
    for (const payload of mine) dispatch(run, payload);
    for (const payload of verdicts) if (!heard.has(JSON.stringify(payload))) dispatch(run, payload);
  }

  /** Closes every run output window the shell has open that no run of this page shows its output in. */
  async function closeUnownedOutputWindows() {
    const keep = runs.value.filter((run) => separate.value[run.key]).map((run) => runOutputWindowName(run.key));
    try {
      await tauriCore()?.invoke('desktop_close_other_output_windows', { keep });
    } catch {
      // A shell without the command: its windows stay until closed.
    }
  }

  /**
   * The page a failed run's end leads to: the execution of its first failure in the Piwi run that reported it, the
   * failure the first of its steps that failed named (`desktopFailedStep`), in the Piwi run of that step, else the first
   * failed test of the run's Piwi run; the run's page when the run names none or does not answer.
   */
  async function failurePage(run: LocalRun): Promise<string> {
    const step = desktopFailedStep(run, useDesktopRunHub().state.endedProgress);
    const runId = (step && run.piwiRunIds?.[step.ref]) ?? run.piwiRunId;
    const runPage = `/test-runs/${runId}`;
    try {
      const details = await $fetch<TestRunDetails>(`/api/test-runs/${runId}`);
      const execution = desktopFailedExecution(details.testCases ?? [], step?.failure ?? null);
      return execution == null ? runPage : `/test-run-cases/${execution}`;
    } catch {
      return runPage;
    }
  }

  /** Opens the tray on a worker of a hub's run: its run expands, and the focus moves to the worker. */
  function showWorker(ref: string, worker: number) {
    trayOpen.value = true;
    shownWorker.value = { ref, worker };
  }

  function clearFinished() {
    runs.value = runs.value.filter((r) => r.status === 'running');
  }

  /**
   * Newest test run of exactly these cases in a project — what a run button reflects, so a button never shows the
   * progress of another page's tests, a reproduction or a bisect.
   */
  function latestForCases(
    projectId: string | number | null | undefined,
    cases: readonly RetryCase[],
  ): LocalRun | undefined {
    if (projectId == null || cases.length === 0) return undefined;
    const id = String(projectId);
    const key = localRunCasesKey(cases);
    return runs.value.find((r) => r.kind === 'tests' && r.projectId === id && localRunCasesKey(r.cases) === key);
  }

  return {
    runs,
    trayOpen,
    shownWorker,
    holds,
    separate,
    keptWindows,
    trayMounts,
    /** Hears each run's end, its status, exit code and verdict set, before the tray can drop it; returns the unsubscribe. */
    onRunEnded(listener: (run: LocalRun) => void): () => void {
      endListeners.add(listener);
      return () => endListeners.delete(listener);
    },
    showWorker,
    failurePage,
    activeCount,
    startRun,
    startReproduce,
    startBisect,
    startFlakeLab,
    startRepro,
    startTeamRequest,
    startJob,
    rerun,
    stopRun,
    clearFinished,
    latestForCases,
    getProjectOptions,
    saveProjectOptions,
    correlatePiwiRuns,
    keepForReload,
    readKeptForReload,
    forgetKeptForReload,
    takeBackAfterReload,
  };
}
