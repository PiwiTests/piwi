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
 */
import {
  buildBisectArgs,
  buildLocalRunPlan,
  buildReproduceArgs,
  type LocalRunMode,
  type LocalRunOptions,
  type LocalRunStep,
} from '~/utils/local-run-args';
import type { RetryCase, RetryMode } from '~/utils/retry-command';
import { commitUrl } from '#shared/scm-urls';
import { specRunVerdict, type SpecRunResult, type SpecRunVerdict } from '@piwitests/core/bug-report';
import type { PiwiSteps } from '@piwitests/core/steps';
import { desktopJobVerdict, flakeLabJobReport, localRunOriginKind, newLocalRunRef } from '~/utils/desktop-job';
import { desktopRunRef } from '~/utils/desktop-run-view';
import type { ReproRequestView } from '#shared/desktop-repro';
import type { FlakeLabJobReport } from '@piwitests/core/desktop-job';

export type LocalRunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'error';

/**
 * What a run is: a plain test run, a full reproduction (checkout → install →
 * test), a bisect, a bug report's steps run from a repro request, or a Flake
 * Lab session (`piwi flake`) at the commit of a test's latest failure, on a
 * test of this app or on an editor's plan.
 */
export type LocalRunKind = 'tests' | 'reproduce' | 'bisect' | 'repro' | 'flake';

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
  text: string;
  error: boolean;
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
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** The editor's job this run answers (kind === 'reproduce', 'bisect' or 'flake'). */
  jobRequestId: string | null;
  /**
   * The origin reference the reporter records for this run (`PIWI_ORIGIN_REF`):
   * the cluster or bug report it was launched for, else one made for it alone.
   */
  originRef: string | null;
  /** Shell id of the step currently spawned, for stopping it. */
  shellId: number | null;
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
  /** The Piwi run this local process produced, once the reporter checked in. */
  piwiRunId: number | null;
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

/** Live label for a running run — test counts when Playwright announced them. */
export function localRunProgressLabel(run: LocalRun): string {
  if (run.stopRequested) return 'Stopping…';
  if (run.kind === 'bisect' && run.bisect) {
    const { step, stepsEstimate, candidates } = run.bisect;
    const current = candidates.findLast((c) => c.verdict === 'testing');
    const short = current ? ` — ${current.sha.slice(0, 7)}` : '';
    if (step != null && stepsEstimate != null) return `Step ${step} of ~${stepsEstimate}${short} — testing…`;
    return `Bisecting${short}…`;
  }
  if (run.phase && run.phase !== 'test') return `${PHASE_LABEL[run.phase]}…`;
  if (run.progressTotal) return `Running ${run.progressDone}/${run.progressTotal}…`;
  return run.steps.length > 1 ? `Running ${run.stepIndex + 1}/${run.steps.length}…` : 'Running…';
}

/** `N tests`, or the test's title when there is one. */
function casesTitle(cases: readonly RetryCase[]): string {
  if (cases.length === 1 && cases[0]!.title) return cases[0]!.title;
  return `${cases.length} test${cases.length === 1 ? '' : 's'}`;
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
 * The options that are not the defaults, in words (`by title · headed · ×20 · trace`), or an empty string: a run button
 * appends them to its face, so what one click runs is never hidden in a menu.
 */
export function localRunOptionsSummary(options: LocalRunOptions): string {
  const parts: string[] = [];
  if (options.mode === 'grep') parts.push('by title');
  else if (options.mode === 'file') parts.push('whole files');
  if (options.runMode === 'headed') parts.push('headed');
  else if (options.runMode === 'debug') parts.push('inspector');
  else if (options.runMode === 'ui') parts.push('UI mode');
  if ((options.repeatEach ?? 1) > 1) parts.push(`×${options.repeatEach}`);
  if (options.trace) parts.push('trace');
  return parts.join(' · ');
}

export const DEFAULT_LOCAL_RUN_OPTIONS: SavedLocalRunOptions = {
  mode: 'file-line',
  runMode: 'normal',
  trace: false,
  repeatEach: 1,
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
const MAX_LINES = 2000;
/**
 * How long after a stop request a run's step counts as over even with no exit
 * event: the shell's grace period before it kills the process, plus a margin.
 */
const STOP_EXIT_FALLBACK_MS = 15_000;
/** Finished runs kept in the tray; running ones are never dropped. */
const MAX_FINISHED = 15;
/** The names on the hub kept per run: one per step of its plan. */
const MAX_HUB_REFS = 20;
const OPTIONS_STORAGE_KEY = 'piwi:desktop-local-run-options';

// Client-only plumbing shared by every composable instance. Runs are driven
// from event handlers after mount, so none of this exists on the server.
let nextKey = 1;
let unlisten: (() => void) | null = null;
let startingSteps = 0;
let pendingEvents: LocalRunEventPayload[] = [];
const runByShellId = new Map<number, LocalRun>();
const exitResolvers = new Map<number, (code: number | null) => void>();
let toastApi: ReturnType<typeof useToast> | null = null;
let routerApi: ReturnType<typeof useRouter> | null = null;
let optionsLoaded = false;

// Playwright's list reporter, as the shell captures it (plain, non-TTY): a
// "Running N tests using M workers" announcement per step, then one line per
// finished test starting with a result mark (✓/✘ or the ASCII fallbacks).
const PROGRESS_TOTAL_RE = /^Running (\d+) tests? using \d+ workers?$/;
const PROGRESS_RESULT_RE = /^\s{1,6}(?:✓|✘|✗|x|ok|-)\s+\d+\s/;

export function useDesktopLocalRuns() {
  const runs = useState<LocalRun[]>('desktop-local-runs', () => []);
  const trayOpen = useState<boolean>('desktop-local-runs-tray', () => false);
  const optionsByProject = useState<Record<string, SavedLocalRunOptions>>('desktop-local-run-options', () => ({}));
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

  function pushLine(run: LocalRun, text: string, error: boolean) {
    run.lines.push({ text, error });
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
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
    let shellId: number;
    try {
      shellId = await core.invoke<number>(cmd, invokeArgs);
    } catch (error) {
      startingSteps -= 1;
      throw error;
    }
    // Same tick as the invoke resolution: register the id, replay buffered
    // events for it, then release the buffer — no event can slip through.
    const exit = new Promise<number | null>((resolve) => exitResolvers.set(shellId, resolve));
    runByShellId.set(shellId, run);
    run.shellId = shellId;
    run.hubRefs = [...run.hubRefs.filter((ref) => ref !== desktopRunRef(shellId)), desktopRunRef(shellId)].slice(
      -MAX_HUB_REFS,
    );
    const mine = pendingEvents.filter((p) => p.id === shellId);
    pendingEvents = startingSteps > 1 ? pendingEvents.filter((p) => p.id !== shellId) : [];
    startingSteps -= 1;
    for (const payload of mine) dispatch(run, payload);
    const code = await exit;
    runByShellId.delete(shellId);
    exitResolvers.delete(shellId);
    run.shellId = null;
    return code;
  }

  async function drive(run: LocalRun) {
    try {
      await ensureListener();
      const worst = run.kind === 'tests' ? await driveTests(run) : await driveSingle(run);
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
      notifyFinished(run);
      trimFinished();
    }
  }

  /** The multi-step test plan: one spawn per Playwright project, worst code wins. */
  async function driveTests(run: LocalRun): Promise<number | null> {
    let worst: number | null = 0;
    for (const [index, step] of run.steps.entries()) {
      if (run.stopRequested) break;
      run.stepIndex = index;
      if (run.steps.length > 1) pushLine(run, `$ ${step.display}`, false);
      const code = await spawnCommand(run, 'desktop_run_local_tests', {
        projectId: run.projectId,
        args: step.args,
        originRef: run.originRef,
      });
      if (run.stopRequested) break;
      if (code !== 0) worst = code ?? 1;
    }
    return worst;
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
    if (run.status === 'passed') {
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
   * shimmed onto native notifications (and the dock/taskbar unread badge) by
   * the desktop plugin.
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
  }): LocalRun {
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
      originRef,
      status: 'running',
      lines: [],
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      shellId: null,
      hubRefs: [],
      stopRequested: false,
      progressTotal: null,
      progressDone: 0,
      piwiRunId: null,
      piwiRunBaseline: null,
    };
    runs.value = [run, ...runs.value];
    const tracked = runs.value[0]!;
    trayOpen.value = true;
    void captureBaseline(tracked);
    void drive(tracked);
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
   * Record the project's newest Piwi run id before our process can report: the
   * run this local process produced is newer (the reporter finds the app via
   * `~/.piwi/desktop.json`).
   */
  async function captureBaseline(run: LocalRun) {
    try {
      const latest = await $fetch<{ id: number } | null>(`/api/projects/${run.projectId}/latest-run`);
      run.piwiRunBaseline = latest?.id ?? 0;
    } catch {
      // Unknown baseline — this run just won't get a Piwi link.
    }
  }

  /**
   * Match local processes to the Piwi runs they produced: the newest run the
   * reporter recorded with this run's origin and reference, newer than the
   * baseline, so runs going at once never take each other's. Driven by the
   * shared SSE stream (the tray subscribes), so the link appears as soon as the
   * reporter checks in.
   */
  async function correlatePiwiRuns() {
    const cutoff = Date.now() - 2 * 60_000;
    for (const run of runs.value) {
      if (run.piwiRunId != null || run.piwiRunBaseline == null) continue;
      if (run.status !== 'running' && (run.finishedAt ?? 0) < cutoff) continue;
      const origin = localRunOriginKind(run.kind);
      if (!origin || !run.originRef) continue;
      try {
        const latest = await $fetch<{ id: number } | null>(`/api/projects/${run.projectId}/latest-run`, {
          query: { origin, ref: run.originRef },
        });
        if (latest && latest.id > run.piwiRunBaseline) run.piwiRunId = latest.id;
      } catch {
        // Server briefly unavailable — the next stream event retries.
      }
    }
  }

  /**
   * Run a repro request the developer confirmed: the shell renders its steps
   * as a spec in the project's test directory, runs it and removes it. The
   * request is marked running here and done, with its verdict, when it ends.
   */
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

  function rerun(run: LocalRun): LocalRun | null {
    if (run.kind === 'repro' && run.repro) {
      const { requestId, steps, args, bugReportId } = run.repro;
      void startRepro({
        projectId: run.projectId,
        projectLabel: run.projectLabel,
        requestId,
        steps,
        args,
        bugReportId,
      }).catch((error) =>
        toastApi?.add({ title: 'Could not run again', description: errorMessage(error), color: 'error' }),
      );
      return null;
    }
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
    activeCount,
    startRun,
    startReproduce,
    startBisect,
    startFlakeLab,
    startRepro,
    startJob,
    rerun,
    stopRun,
    clearFinished,
    latestForCases,
    getProjectOptions,
    saveProjectOptions,
    correlatePiwiRuns,
  };
}
