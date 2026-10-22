/**
 * What the extension shows, computed from the editor service's answers with
 * no VS Code API, so it is tested without an editor: the status bar item, the
 * failures view's tree, the file patterns the service reads, the MCP
 * configuration editors without the MCP provider API are given to paste, the
 * file a dashboard's open link names, and the recorded block a recording
 * writes and follows through the edits around it.
 */
import type {
  BaselineChoice,
  ConnectionSource,
  CoverageResult,
  DesktopJobUpdate,
  DesktopResult,
  FailuresGrouping,
  FailuresResult,
  FailureTreeIcon,
  FailureTreeNode,
  FileEdit,
  LineSpan,
  LiveRun,
  McpServerDefinition,
  RecordingPlacement,
  RecordingStep,
  RecordingUpdate,
  RunStatus,
  RunEnded,
  RunStatusResult,
  RunTestsArgs,
  StatusResult,
  SummaryLine,
  TestAtResult,
  TestLineStatus,
  WorkspaceFailure,
} from '@piwitests/editor/protocol';
import * as path from 'node:path';
import { isUnder } from './breakpoints';

/** The files the editor service reads: test and application code (C# and Razor views too), and translations. */
export const DOCUMENT_PATTERN =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte,astro,html,json,yaml,yml,properties,po,resx,cs,cshtml,razor}';

export interface StatusBarView {
  text: string;
  /** Markdown: what the item shows and when it was read, then links to the run, the dashboard and Connect. */
  tooltip: string;
  /**
   * `refresh` reads the latest run again (`piwi.refreshRun`); `retry` reads the instance again (`piwi.refresh`);
   * `connect` runs Piwi: Connect.
   */
  action: 'refresh' | 'retry' | 'connect' | 'none';
  /** The latest run's page, which `piwi.openRun` opens. */
  url: string | null;
  /** Whether the item uses the editor's error background. */
  error: boolean;
}

const ACTIVE = new Set(['running', 'initializing', 'finalizing']);

/** The commands the status bar item's tooltip links to. */
export const STATUS_TOOLTIP_COMMANDS = [
  'piwi.openRun',
  'piwi.openInDashboard',
  'piwi.compareWith',
  'piwi.connect',
  'piwi.refresh',
];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A text shown as written in Markdown. */
function md(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, '\\$&');
}

/** Markdown lines, each a paragraph of its own, without the empty ones. */
function lines(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join('\n\n');
}

/** How long before `now` an ISO 8601 time is: `12 s ago`, `4 min ago`, `2 h ago`, `3 d ago`, or `just now`. */
export function relativeTime(iso: string, now: number): string {
  const seconds = Math.floor((now - Date.parse(iso)) / 1000);
  if (!(seconds >= 1)) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/**
 * A line on the desktop app when it is not in use: it runs and Connect can
 * switch to it, or it was chosen and does not run. Null otherwise.
 */
function desktopHint(status: StatusResult | null, desktopChosen: boolean): string | null {
  const inUse = status?.contexts.some((c) => c.source === 'desktop');
  if (!status || inUse) return null;
  if (status.desktopUrl) return 'The Piwi desktop app runs on this machine: Piwi: Connect to use it.';
  return desktopChosen ? 'The Piwi desktop app, chosen with Piwi: Connect, is not running.' : null;
}

/** A run in progress in the status bar: `$(sync~spin) Piwi: 4/9 · 1 failing`, and ` · your run` for the editor's own. */
function liveText(live: LiveRun): string {
  const failing = live.failed ? ` · ${live.failed} failing` : '';
  return `$(sync~spin) Piwi: ${live.done}/${live.total}${failing}${live.own ? ' · your run' : ''}`;
}

/** The tooltip's line on a run in progress: `Your run #124 is running: 4/9 · 1 failing`. */
function liveLine(live: LiveRun): string {
  const failing = live.failed ? ` · ${live.failed} failing` : '';
  return `${live.own ? 'Your run' : 'Run'} #${live.runId} is running: ${live.done}/${live.total}${failing}`;
}

/** When the latest run was read, and how the service learns of the next: `Updated 12 s ago · live`. */
function updatedLine(run: RunStatus | undefined, now: number): string | null {
  if (!run?.updatedAt) return null;
  const how = run.stream === 'live' ? ' · live' : run.stream === 'polling' ? ' · read every minute' : '';
  return `Updated ${relativeTime(run.updatedAt, now)}${how}`;
}

/** The baseline a context compares with, as the tooltip and the failures view name it: `Baseline: CI run #120 on main`. */
export function baselineLine(label: string | undefined): string | null {
  return label ? `Baseline: ${label}` : null;
}

/** The item's text while the latest run is read again: its icon spins. */
export function refreshingText(text: string): string {
  return `$(sync~spin) ${text.replace(/^\$\([^)]*\)\s*/, '')}`;
}

type StatusContext = StatusResult['contexts'][number];

/**
 * The context the status bar item speaks for: the one whose Playwright config folder holds the active file, the
 * deepest when several do; else the first connected one, else the first the instance did not answer, else the first.
 */
export function statusContext(contexts: readonly StatusContext[], activeFile: string | null): StatusContext | null {
  const holding = activeFile
    ? contexts.filter((c) => isUnder(c.root, activeFile)).sort((a, b) => b.root.length - a.root.length)[0]
    : undefined;
  return (
    holding ??
    contexts.find((c) => c.connected) ??
    contexts.find((c) => c.problemKind === 'unreachable') ??
    contexts[0] ??
    null
  );
}

/**
 * With several Playwright configs, which one the item speaks for: `The active file's Playwright config, in apps/admin
 * (one of 3)`.
 */
function configLine(
  contexts: readonly StatusContext[],
  shown: StatusContext,
  activeFile: string | null,
): string | null {
  if (contexts.length < 2) return null;
  const where = shown.label ?? path.basename(shown.root);
  return activeFile && isUnder(shown.root, activeFile)
    ? md(`The active file's Playwright config, in ${where} (one of ${contexts.length})`)
    : md(`The Playwright config in ${where} (one of ${contexts.length}): open a file of another one to see its run`);
}

/**
 * The status bar item, for the Playwright config of the active file (`statusContext`): the latest run on the
 * checked-out branch, with what the runs laid over it fixed or still fail, or what keeps the service from reading it.
 * While a run is in progress, the editor's own or one on the branch, the item counts it, and the tooltip has both. A
 * click reads the latest run again; the tooltip names the config when there are several, says when the run was read
 * and links to the run, the dashboard and Connect.
 */
export function statusBarView(
  status: StatusResult | null,
  runs: RunStatusResult | null,
  desktopChosen = false,
  now = Date.now(),
  activeFile: string | null = null,
): StatusBarView {
  const contexts = status?.contexts ?? [];
  const shown = statusContext(contexts, activeFile);
  if (!shown) {
    return { text: '$(beaker) Piwi', tooltip: 'No Playwright config found', action: 'none', url: null, error: false };
  }
  const hint = desktopHint(status, desktopChosen);
  const connect = '[Connect](command:piwi.connect)';
  const which = configLine(contexts, shown, activeFile);
  if (!shown.connected && shown.problemKind === 'unreachable') {
    return {
      text: '$(debug-disconnect) Piwi: unreachable',
      tooltip: lines(
        md(shown.problem ?? 'The instance did not answer'),
        which,
        'Piwi reads it again on its own.',
        hint,
        `[Retry](command:piwi.refresh) · ${connect}`,
      ),
      action: 'retry',
      url: null,
      error: false,
    };
  }
  if (!shown.connected) {
    return {
      text: '$(plug) Piwi: connect',
      tooltip: lines(md(shown.problem ?? 'Not connected'), which, hint, connect),
      action: 'connect',
      url: null,
      error: false,
    };
  }
  const connected = shown;
  const run =
    runs?.contexts.find((c) => c.root === connected.root) ?? (contexts.length === 1 ? runs?.contexts[0] : undefined);
  // On the ladder, the checked-out branch has no run yet: another branch's is shown.
  const ladder = !run?.baseline || run.baseline.choice.kind === 'ladder';
  const fallback =
    ladder && run?.run && run.checkedOut && run.checkedOut !== run.branch ? ` (${run.checkedOut} has no run yet)` : '';
  const where = md(`${connected.projectName ?? 'Piwi'}${run?.branch ? ` on ${run.branch}` : ''}${fallback}`);
  const from = connected.serverUrl ? md(`${connected.serverUrl}, from ${sourceLabel(connected.source)}`) : null;
  const reporter = run?.reporterVersion ? md(`reporter ${run.reporterVersion}`) : null;
  const live = run?.live ?? null;
  const progress = live ? liveLine(live) : null;
  const updated = updatedLine(run, now);
  const baseline = run?.baseline ? md(baselineLine(run.baseline.label)!) : null;
  const dashboard = '[Open in dashboard](command:piwi.openInDashboard)';
  const compare = '[Compare with…](command:piwi.compareWith)';
  if (!run?.run) {
    const links = `${dashboard} · ${compare} · ${connect}`;
    if (run?.overlays) {
      // A developer's own runs alone, with no baseline.
      const failing = run.failingTests ?? run.failures;
      return {
        text: live ? liveText(live) : failing ? `$(error) Piwi: ${failing} failing` : '$(pass) Piwi: no failure',
        tooltip: lines(
          `${plural(run.overlays, 'local run')} of ${where}, ${plural(failing, 'test')} failing`,
          which,
          baseline,
          progress,
          updated,
          from,
          reporter,
          hint,
          links,
        ),
        action: 'refresh',
        url: null,
        error: !live && failing > 0,
      };
    }
    return {
      text: live ? liveText(live) : '$(beaker) Piwi: no run',
      tooltip: lines(`No run of ${where} yet`, which, baseline, progress, updated, from, reporter, hint, links),
      action: 'refresh',
      url: null,
      error: false,
    };
  }
  const r = run.run;
  // The tests still failing once the later runs are laid over the run; the run's own count from an older service.
  const failing = run.failingTests ?? r.failedTests;
  const fixed = run.resolved ?? 0;
  const tooltip = lines(
    `Run #${r.id} of ${where}: ${r.passedTests} passed, ${r.failedTests} failed, ${r.flakyTests} flaky, ${r.skippedTests} skipped`,
    which,
    baseline,
    run.overlays ? `${plural(run.overlays, 'local run')} since · ${plural(fixed, 'test')} fixed locally` : null,
    progress,
    updated,
    from,
    reporter,
    hint,
    `[Open run #${r.id}](command:piwi.openRun) · ${dashboard} · ${compare} · ${connect}`,
  );
  const view = { tooltip, action: 'refresh' as const, url: r.url, error: false };
  if (live || ACTIVE.has(r.status)) {
    const done = r.passedTests + r.failedTests + r.flakyTests + r.skippedTests;
    const failed = r.failedTests ? ` · ${r.failedTests} failing` : '';
    return { ...view, text: live ? liveText(live) : `$(sync~spin) Piwi: ${done}/${r.totalTests}${failed}` };
  }
  const flaky = r.flakyTests ? ` · ${r.flakyTests} flaky` : '';
  if (failing > 0) {
    const fixedText = fixed ? ` · ${fixed} fixed locally` : '';
    return { ...view, text: `$(error) Piwi: ${failing} failing${fixedText}${flaky}`, error: true };
  }
  if (r.status !== 'passed' && r.status !== 'failed') return { ...view, text: `$(warning) Piwi: ${r.status}` };
  if (fixed > 0) return { ...view, text: `$(pass) Piwi: ${fixed} fixed locally` };
  return { ...view, text: `$(pass) Piwi: ${plural(r.passedTests, 'passed', 'passed')}${flaky}` };
}

/**
 * What the notification says once a locator picked while a run was paused at a breakpoint reached the editor: it
 * replaced the locator of its line, or it went to the cursor because the line holds none, or because the file is not
 * in the workspace.
 */
export function pickNotice(at: { file: string; line: number }, outcome: 'replaced' | 'no-locator' | 'no-file'): string {
  const name = at.file.slice(at.file.lastIndexOf('/') + 1);
  if (outcome === 'replaced') return `Piwi: the picked locator replaced the one at line ${at.line} of ${name}.`;
  if (outcome === 'no-locator') {
    return `Piwi: the picked locator was inserted at the cursor: line ${at.line} of ${name} holds no locator anymore.`;
  }
  return `Piwi: the picked locator was inserted at the cursor: ${at.file} is not in this workspace.`;
}

/**
 * The runs as the files show them, in one string: without the run in progress, the stream and the time of the last
 * read, which move while the latest run and its failures stay. The files are drawn again when it changes.
 */
export function runsInFiles(runs: RunStatusResult | null): string {
  return JSON.stringify(
    runs?.contexts.map((c) => ({ ...c, live: undefined, stream: undefined, updatedAt: undefined })) ?? null,
  );
}

/**
 * What a change of the runs from `before` to `after` draws again in the files: `none` when only the run in progress
 * moved ({@link runsInFiles}); `tests` when only the tests of the run in progress began or ended (`liveTests`), which
 * only a test's line shows; `all` when anything else the files show changed, such as the latest run or its baseline.
 */
export function filesRedraw(before: RunStatusResult | null, after: RunStatusResult | null): 'none' | 'tests' | 'all' {
  if (runsInFiles(before) === runsInFiles(after)) return 'none';
  const withoutTests = (runs: RunStatusResult | null) =>
    runsInFiles(runs && { ...runs, contexts: runs.contexts.map((c) => ({ ...c, liveTests: undefined })) });
  return withoutTests(before) === withoutTests(after) ? 'tests' : 'all';
}

/** The editor's own run in progress, as the failures view's first node shows it, in one string. */
export function ownLiveRun(runs: RunStatusResult | null): string {
  return JSON.stringify(runs?.contexts.find((c) => c.live?.own)?.live ?? null);
}

/** How the failures view groups the failures under the run. */
export const FAILURES_GROUPINGS: Array<{ grouping: FailuresGrouping; label: string; detail: string }> = [
  { grouping: 'file', label: 'File', detail: 'The spec each failing test is in' },
  { grouping: 'cluster', label: 'Cluster', detail: 'The failure cluster: one root cause, one group' },
  { grouping: 'owner', label: 'Owner', detail: 'The owner the test names, or CODEOWNERS' },
  { grouping: 'flat', label: 'Flat', detail: 'Every failure under the run' },
];

/** A node of the failures view: a node of the service's tree (`FailuresResult.tree`), as the view draws it. */
export interface FailureNode {
  /** Stable across refreshes: the view keeps a node's expansion and selection by it. */
  key: string;
  kind: FailureTreeNode['kind'];
  label: string;
  description: string;
  /** Markdown. */
  tooltip: string;
  /** A codicon name: `error`, `edit`, `check` for a failure's state, others for the rest. */
  icon: string;
  /** `expanded` and `collapsed` for a node with children, `none` for a leaf. */
  state: 'expanded' | 'collapsed' | 'none';
  /** The page a click on a run opens; a failure's execution page. */
  url: string | null;
  /** On a Playwright config's node and a run's: that config's folder, which their actions act on. */
  root?: string;
  /** The failure a leaf stands for. */
  failure?: WorkspaceFailure;
  children: FailureNode[];
}

/** The codicon of each icon of the service's tree. */
const FAILURE_ICONS: Record<FailureTreeIcon, string> = {
  context: 'root-folder',
  run: 'beaker',
  history: 'history',
  failed: 'error',
  passed: 'pass',
  file: 'file',
  cluster: 'symbol-namespace',
  owner: 'person',
  failing: 'error',
  edited: 'edit',
  fixed: 'check',
};

/**
 * The failures view's nodes, from the tree the service grouped: a run's age after its description (`4 min ago`), and,
 * while the editor's own run is `live`, that run on the node of the run of its Playwright config (`liveRoot`; any run's
 * node when either does not say which: `running 4/9`), whose tooltip says it too.
 */
export function failureNodes(
  result: FailuresResult | null,
  options: { now?: number; live?: LiveRun | null; liveRoot?: string | null } = {},
): FailureNode[] {
  const now = options.now ?? Date.now();
  const live = options.live?.own ? options.live : null;
  const failures = new Map((result?.items ?? []).map((f) => [f.executionId, f]));
  const draw = (node: FailureTreeNode): FailureNode => {
    const age = node.startTime ? relativeTime(node.startTime, now) : null;
    const running = live && node.kind === 'run' && (!options.liveRoot || !node.root || node.root === options.liveRoot);
    const [first, ...rest] = node.tooltip.map(md);
    return {
      key: node.key,
      kind: node.kind,
      label: node.label,
      description: running ? `running ${live.done}/${live.total}` : [node.description, age].filter(Boolean).join(' · '),
      tooltip: lines(
        node.kind === 'failure' && first ? `**${first}**` : first,
        ...rest,
        running ? `Your run #${live.runId} is running: ${live.done}/${live.total}` : null,
      ),
      icon: FAILURE_ICONS[node.icon] ?? 'circle-outline',
      state: node.children.length ? (node.expanded ? 'expanded' : 'collapsed') : 'none',
      url: node.url,
      ...(node.root ? { root: node.root } : {}),
      ...(node.executionId !== undefined && failures.has(node.executionId)
        ? { failure: failures.get(node.executionId)! }
        : {}),
      children: node.children.map(draw),
    };
  };
  return (result?.tree ?? []).map(draw);
}

/**
 * What **Re-run the failing tests** runs: the tests still failing of every Playwright config, one run each
 * (`FailuresResult.rerun`), or of the config at `root` alone, run from its node in the failures view.
 */
export function failingRuns(result: FailuresResult | null, root?: string): RunTestsArgs[] {
  const runs = result?.rerun ?? [];
  return root ? runs.filter((r) => r.root === root) : runs;
}

/** An entry of **Compare with…**: a baseline, or `run-by-id`, which asks for the run's id first. */
export interface BaselinePick {
  label: string;
  description: string;
  detail: string;
  choice: BaselineChoice | 'run-by-id';
}

function sameChoice(a: BaselineChoice, b: BaselineChoice): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What **Compare with…** offers for a context: the ladder (`CI on the checked-out branch, else main (default)`), the
 * default branch and each branch with runs, a run by its id, and the developer's own runs only; the choice in force is
 * `current`.
 */
export function baselinePicks(run: RunStatus | undefined): BaselinePick[] {
  const current: BaselineChoice = run?.baseline?.choice ?? { kind: 'ladder' };
  const branches = [...(run?.branches ?? [])];
  if (current.kind === 'branch' && !branches.includes(current.branch)) branches.push(current.branch);
  const mark = (choice: BaselineChoice, also = '') =>
    [also, sameChoice(choice, current) ? 'current' : ''].filter(Boolean).join(' · ');
  const ladder: BaselineChoice = { kind: 'ladder' };
  const local: BaselineChoice = { kind: 'local' };
  return [
    {
      label: `CI on the checked-out branch, else ${run?.branches?.[0] ?? 'the default branch'} (default)`,
      description: mark(ladder),
      detail: 'The latest complete run of the branch, a CI run first, with your runs since laid over it',
      choice: ladder,
    },
    ...branches.map((branch, i) => {
      const choice: BaselineChoice = { kind: 'branch', branch };
      return {
        label: branch,
        description: mark(choice, i === 0 && run?.branches?.[0] === branch ? 'default branch' : ''),
        detail: `The latest complete run of ${branch}, a CI run first`,
        choice,
      };
    }),
    {
      label: 'A run by id…',
      description: current.kind === 'run' ? `current: run #${current.runId}` : '',
      detail: 'One run of the project, with the runs of its branch since',
      choice: 'run-by-id',
    },
    {
      label: 'My local runs only',
      description: mark(local),
      detail: 'Your runs on this machine, in the desktop app or an editor, without CI',
      choice: local,
    },
  ];
}

/** The baselines kept per context root, with `choice` for `root`: the ladder is kept as no entry. */
export function withBaseline(
  kept: Record<string, BaselineChoice> | undefined,
  root: string,
  choice: BaselineChoice,
): Record<string, BaselineChoice> {
  const next = { ...kept };
  if (choice.kind === 'ladder') delete next[root];
  else next[root] = choice;
  return next;
}

/** What **Run this test** runs for a failure: its test, from the Playwright config it belongs to. */
export function failureRunArgs(failure: WorkspaceFailure): RunTestsArgs | null {
  if (failure.testCaseId === undefined) return null;
  return { uri: failure.uri, ...(failure.root ? { root: failure.root } : {}), testIds: [failure.testCaseId] };
}

/** A test's latest result, drawn on the test: a gutter icon, a hover, and a background while it fails. */
export interface TestDecoration {
  status: TestLineStatus;
  line: number;
  /** The last line of a failing test's background; null for any other result. */
  failingUntil: number | null;
  /** The line a failing test failed at, when the latest run says, edited since or not; null otherwise. */
  failingLine: number | null;
  hover: string;
  dashboardUrl: string | null;
  /** The test's id, which **Run** in its hover runs; null from a service that does not give it. */
  testCaseId: number | null;
}

/** The commands a test's gutter hover runs: `enabledCommands` of its trusted `MarkdownString`. */
export const TEST_HOVER_COMMANDS = ['piwi.openInDashboard', 'piwi.runTests'];

/** A test's gutter hover in the file at `uri`: its result, then **Run** and **Open in dashboard** when it has them. */
export function testHoverMarkdown(test: TestDecoration, uri: string): string {
  const link = (title: string, command: string, args: unknown[]) =>
    `[${title}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
  const links = [
    test.testCaseId !== null
      ? link('Run', 'piwi.runTests', [{ uri, testIds: [test.testCaseId] } satisfies RunTestsArgs])
      : '',
    test.dashboardUrl ? link('Open in dashboard', 'piwi.openInDashboard', [test.dashboardUrl]) : '',
  ].filter(Boolean);
  return links.length ? `${test.hover}\n\n${links.join(' · ')}` : test.hover;
}

/** The decorations of a file's tests: the summary lines that carry a result. */
export function testDecorations(lines: SummaryLine[]): TestDecoration[] {
  return lines.flatMap((l) =>
    l.status
      ? [
          {
            status: l.status,
            line: l.line,
            failingUntil: l.status === 'failed' ? Math.max(l.line, l.endLine ?? l.line) : null,
            failingLine: l.failure?.line ?? null,
            hover: testResultHover(l.status, l.title, l.failure?.state === 'edited'),
            dashboardUrl:
              l.command?.command === 'piwi.openInDashboard' && typeof l.command.arguments?.[0] === 'string'
                ? (l.command.arguments[0] as string)
                : null,
            testCaseId: l.testCaseId ?? null,
          },
        ]
      : [],
  );
}

/**
 * A test's hover: its latest result, whether the line it failed at changed since the run (`edited`), then its
 * history as the service sums it up.
 */
export function testResultHover(status: TestLineStatus, title: string, edited = false): string {
  const result = {
    failed: 'failing',
    flaky: 'flaky',
    passed: 'passing',
    skipped: 'skipped',
    running: 'running',
    unknown: 'no recent result',
  }[status];
  return [`**Piwi**: ${result}`, edited ? 'edited since the run' : '', md(title)].filter(Boolean).join(' · ');
}

/** The coverage marks of a file, as whole lines: those the tests ran, the executable ones none runs, those changed since. */
export interface CoverageDecorations {
  run: LineSpan[];
  notRun: LineSpan[];
  changed: LineSpan[];
}

/**
 * The marks to draw for a file's `piwi/coverage` answer, within its `lineCount` lines: none while they are hidden, and
 * none for a file without line coverage.
 */
export function coverageDecorations(
  result: CoverageResult | null | undefined,
  lineCount: number,
  shown: boolean,
): CoverageDecorations {
  const within = (spans: LineSpan[] | undefined) =>
    (spans ?? [])
      .filter((s) => s.start >= 0 && s.start < lineCount && s.end >= s.start)
      .map((s) => ({ start: s.start, end: Math.min(s.end, lineCount - 1) }));
  if (!shown || !result || !hasCoverageMarks(result)) return { run: [], notRun: [], changed: [] };
  return { run: within(result.executed), notRun: within(result.notRun), changed: within(result.changed) };
}

/** Whether a `piwi/coverage` answer marks lines: coverage was recorded on the file as it stands, or placed on it. */
export function hasCoverageMarks(result: CoverageResult | null | undefined): boolean {
  return result?.state === 'exact' || result?.state === 'mapped';
}

/** When a run the editor started says what it changed: `piwi.runNotifications`. */
export type RunNotifications = 'always' | 'failures' | 'never';

/** The actions a run's verdict offers. */
export const VERDICT_ACTIONS = {
  failures: 'Open the failures',
  dashboard: 'Open in dashboard',
  rerun: 'Re-run failing',
} as const;

/** Titles as a verdict lists them: the first ones, then how many more. */
function titleList(titles: string[], count: number): string {
  const more = count - titles.length;
  return `(${titles.join(', ')}${more > 0 ? ` and ${more} more` : ''})`;
}

/**
 * What a run the editor started changed, once it ended: `Piwi: run #124 · 1 of 3 CI failures fixed, 2 still failing
 * (login.spec.ts › logs in, checkout.spec.ts › pays)`, then its new failures, else its counts. A warning when something
 * fails, with **Re-run failing**; an information otherwise. Null when `setting` keeps it quiet. A run of each test
 * several times says how many of its runs passed, `Piwi: run #124 · Failed 1 of 3`, whatever the setting.
 */
export function runVerdict(
  ended: RunEnded,
  setting: RunNotifications = 'always',
): { severity: 'information' | 'warning'; text: string; actions: string[] } | null {
  if (ended.repeat) {
    const { verdict, failed } = ended.repeat;
    return {
      severity: failed ? 'warning' : 'information',
      text: `Piwi: run #${ended.runId} · ${verdict}`,
      actions: [VERDICT_ACTIONS.failures, VERDICT_ACTIONS.dashboard],
    };
  }
  const still = ended.stillFailingCount ?? ended.stillFailing.length;
  const added = ended.newFailureCount ?? ended.newFailures.length;
  const parts: string[] = [];
  if (ended.fixed || still) {
    const fixed = `${ended.fixed} of ${ended.fixed + still} CI ${ended.fixed + still === 1 ? 'failure' : 'failures'} fixed`;
    parts.push(still ? `${fixed}, ${still} still failing ${titleList(ended.stillFailing, still)}` : fixed);
  }
  if (added) parts.push(`${plural(added, 'new failure')} ${titleList(ended.newFailures, added)}`);
  if (!parts.length) {
    const counts = [`${ended.passed} passed`, `${ended.failed} failed`];
    if (ended.flaky) counts.push(`${ended.flaky} flaky`);
    if (ended.skipped) counts.push(`${ended.skipped} skipped`);
    parts.push(counts.join(', '));
  }
  const failing = still + added > 0 || ended.failed > 0;
  if (setting === 'never' || (setting === 'failures' && !failing)) return null;
  return {
    severity: failing ? 'warning' : 'information',
    text: `Piwi: run #${ended.runId} · ${parts.join(' · ')}`,
    actions: [VERDICT_ACTIONS.failures, VERDICT_ACTIONS.dashboard, ...(failing ? [VERDICT_ACTIONS.rerun] : [])],
  };
}

/** Where the service found the instance: the settings come last. */
export function sourceLabel(source: ConnectionSource | null | undefined): string {
  switch (source) {
    case 'environment':
      return 'the environment (PIWI_DASHBOARD_URL)';
    case 'dotenv':
      return 'the workspace .env';
    case 'desktop':
      return 'the Piwi desktop app';
    default:
      return 'the Piwi settings';
  }
}

/** What Piwi: Disconnect asks before forgetting the saved connection; null when nothing is saved. */
export function disconnectQuestion(serverUrl: string | null, project: string | null, desktop = false): string | null {
  const parts: string[] = [];
  if (serverUrl) parts.push(`${serverUrl}, the project, and the API key saved for it`);
  else if (project) parts.push(`the project ${project} saved for the desktop app`);
  if (desktop) parts.push('the choice of the desktop app');
  return parts.length ? `forget ${parts.join(', and ')}?` : null;
}

/** A connection Piwi: Connect offers when the desktop app runs. */
export interface ConnectChoice {
  target: 'desktop' | 'instance' | 'other';
  label: string;
  description: string;
  detail: string;
  /** The address of an `instance`; null otherwise. */
  serverUrl: string | null;
}

/**
 * What Piwi: Connect offers when the desktop app runs: the app, the instance
 * the environment, the `.env` or the settings name (the app does not replace
 * it: either is one pick away), and another instance. The one in use says so.
 */
export function connectChoices(
  status: StatusResult | null,
  desktop: DesktopResult,
  savedUrl: string | null,
): ConnectChoice[] {
  const context = status?.contexts.find((c) => c.connected) ?? status?.contexts[0];
  const usesDesktop = context?.source === 'desktop';
  const choices: ConnectChoice[] = [
    {
      target: 'desktop',
      label: '$(device-desktop) The Piwi desktop app',
      description: `${desktop.url ?? ''}${usesDesktop ? ' · in use' : ''}`,
      detail: desktop.linked
        ? `Runs on this machine; this folder is linked there to the project ${desktop.linked.name}.`
        : 'Runs on this machine: no address or key needed.',
      serverUrl: null,
    },
  ];
  const instance = context?.instance ?? (savedUrl ? { serverUrl: savedUrl, source: 'editor' as const } : null);
  if (instance && instance.serverUrl !== desktop.url) {
    choices.push({
      target: 'instance',
      label: `$(server) ${instance.serverUrl}`,
      description: !usesDesktop && context?.serverUrl === instance.serverUrl ? 'in use' : '',
      detail: `From ${sourceLabel(instance.source)}.`,
      serverUrl: instance.serverUrl,
    });
  }
  choices.push({
    target: 'other',
    label: '$(globe) Another instance…',
    description: '',
    detail: 'A Piwi server, by its address.',
    serverUrl: null,
  });
  return choices;
}

/** A VS Code `mcp.json` holding Piwi's servers, for editors without the MCP provider API. */
export function mcpConfiguration(servers: McpServerDefinition[]): string {
  const entries = servers.map((s, i) => [
    i === 0 ? 'piwi' : `piwi-${i + 1}`,
    { type: 'http', url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}) },
  ]);
  return JSON.stringify({ servers: Object.fromEntries(entries) }, null, 2);
}

/**
 * How a desktop job's update shows: a job that ended without a verdict (declined, expired, the app gone, or an
 * error) as a warning, anything else as information, with the share button when the verdict can be shared.
 */
export function desktopJobNotice(update: DesktopJobUpdate): {
  severity: 'information' | 'warning';
  text: string;
  actions: string[];
} {
  const failed = update.status !== 'done' && update.status !== 'running';
  return {
    severity: failed || update.message.startsWith('The desktop app could not') ? 'warning' : 'information',
    text: `Piwi: ${update.message}`,
    actions: update.share ? [update.share.label] : [],
  };
}

/** A position in a document: 0-based line and character, as the editor counts them. */
export interface TextPosition {
  line: number;
  character: number;
}

/** A range of a document. */
export interface TextSpan {
  start: TextPosition;
  end: TextPosition;
}

/** `range` replaced with `text`: a change the document went through, or an edit to make. */
export interface TextChange {
  range: TextSpan;
  text: string;
}

const LINE_BREAK = /\r\n|\r|\n/;

function comparePositions(a: TextPosition, b: TextPosition): number {
  return a.line - b.line || a.character - b.character;
}

function point(line: number, character: number): TextSpan {
  return { start: { line, character }, end: { line, character } };
}

/** Where `text` ends once inserted at `start`. */
function endOfInsert(start: TextPosition, text: string): TextPosition {
  const lines = text.split(LINE_BREAK);
  return lines.length === 1
    ? { line: start.line, character: start.character + text.length }
    : { line: start.line + lines.length - 1, character: lines[lines.length - 1]!.length };
}

/** Where a position at or after the end of a change's range is once the change is made. */
function afterChange(position: TextPosition, change: TextChange): TextPosition {
  const end = endOfInsert(change.range.start, change.text);
  return position.line === change.range.end.line
    ? { line: end.line, character: end.character + position.character - change.range.end.character }
    : { line: position.line + end.line - change.range.end.line, character: position.character };
}

/**
 * The recorded block as the file holds it: `RecordingUpdate.code` with every non-empty line prefixed with the
 * placement's indentation.
 */
export function recordedBlockText(code: string, indent: string): string {
  return code
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n');
}

/**
 * Where the recorded block is. Until its first write, `range` is the start of the line `RecordResult.placement`
 * names, and `first` says how that write places the block: `insert` it on a new line there, or `replace` that line
 * while it is blank. Null once written: every later write replaces the block.
 */
export interface RecordedBlock {
  range: TextSpan;
  first: 'insert' | 'replace' | null;
}

/** The block of a recording that has written nothing yet: the start of the line its placement names. */
export function placedBlock(placement: RecordingPlacement): RecordedBlock {
  return { range: point(placement.line, 0), first: placement.newLine ? 'insert' : 'replace' };
}

/**
 * Follows the recorded block through one change of the document. A change `above` the block moves it and one `below`
 * it leaves it; one `inside` it, or across one of its edges, changes its text, and the block then covers what the
 * change wrote. Whole lines added or removed right before the block, or added right after it, stay outside it.
 */
export function followBlock(
  block: TextSpan,
  change: TextChange,
): { block: TextSpan; where: 'above' | 'inside' | 'below' } {
  const { start, end } = change.range;
  const touchesStart = comparePositions(end, block.start);
  const touchesEnd = comparePositions(start, block.end);
  const above =
    touchesStart < 0 ||
    (touchesStart === 0 && block.start.character === 0 && endOfInsert(start, change.text).character === 0);
  if (above) {
    return { where: 'above', block: { start: afterChange(block.start, change), end: afterChange(block.end, change) } };
  }
  if (touchesEnd > 0 || (touchesEnd === 0 && /^(?:\r\n|\r|\n)/.test(change.text))) return { where: 'below', block };
  return {
    where: 'inside',
    block: {
      start: comparePositions(start, block.start) < 0 ? start : block.start,
      end: comparePositions(end, block.end) >= 0 ? endOfInsert(start, change.text) : afterChange(block.end, change),
    },
  };
}

/** An insertion the service placed, moved through the changes the document went through since. */
export function followEdit(edit: FileEdit, changes: TextChange[]): FileEdit {
  let at: TextSpan = edit.range;
  for (const change of changes) at = followBlock(at, change).block;
  return { range: { start: at.start, end: at.start }, newText: edit.newText };
}

/** The line a change edits without adding or removing a line: its range and its text on that line alone; else null. */
export function editedLine(change: TextChange): number | null {
  const { start, end } = change.range;
  return start.line === end.line && !LINE_BREAK.test(change.text) ? start.line : null;
}

/** A quick fix on a recorded line's warning: another locator of the step, for the written one at `[start, end)`. */
export interface LocatorChoice {
  /** `Use getByTestId('pay')`. */
  title: string;
  locator: string;
  start: number;
  end: number;
}

/**
 * The other locators the recorder verified for a step, best first, as quick fixes on `line`, the text of the line the
 * step is written on: each puts its locator in place of the written one (`RecordingStep.chosen`), which is found on the
 * line as it is written, after a page expression or inside a call. None when the step has a single locator, or when
 * the written one is not on the line exactly once.
 */
export function locatorChoices(line: string, step: Pick<RecordingStep, 'locators' | 'chosen'>): LocatorChoice[] {
  const locators = step.locators ?? [];
  const written = step.chosen == null ? undefined : locators[step.chosen];
  if (!written || locators.length < 2) return [];
  const start = line.indexOf(written);
  if (start < 0 || line.includes(written, start + 1)) return [];
  return locators
    .filter((locator) => locator && locator !== written)
    .map((locator) => ({ title: `Use ${locator}`, locator, start, end: start + written.length }));
}

/** The service's import edit as a change of the document; null without one. */
export function importChange(edit: FileEdit | null | undefined): TextChange | null {
  return edit ? { range: edit.range, text: edit.newText } : null;
}

/**
 * The edit that writes the recorded block's new text, with the service's import edit (`RecordingUpdate.importEdit`,
 * placed in the document as it stands) in the same edit, and the block's range once it is made. The first write
 * places the block as `first` says; every later one replaces the block, keeping it on lines of its own. An import edit
 * inside the range the block replaces is left out.
 */
export function writeBlock(
  lines: string[],
  block: RecordedBlock,
  text: string,
  importEdit: FileEdit | null,
): { changes: TextChange[]; block: TextSpan } {
  const lastLine = Math.max(lines.length - 1, 0);
  const line = block.range.start.line;
  let change: TextChange;
  let startLine: number;
  if (block.first && line >= lines.length) {
    change = { range: point(lastLine, (lines[lastLine] ?? '').length), text: `\n${text}` };
    startLine = lines.length;
  } else if (block.first === 'insert' || (block.first === 'replace' && lines[line]!.trim())) {
    change = { range: point(line, 0), text: `${text}\n` };
    startLine = line;
  } else if (block.first === 'replace') {
    change = { range: { start: { line, character: 0 }, end: { line, character: lines[line]!.length } }, text };
    startLine = line;
  } else {
    const clamp = (p: TextPosition): TextPosition =>
      p.line > lastLine
        ? { line: lastLine, character: (lines[lastLine] ?? '').length }
        : { line: p.line, character: Math.min(p.character, (lines[p.line] ?? '').length) };
    let start = clamp(block.range.start);
    let end = clamp(block.range.end);
    const startText = lines[start.line] ?? '';
    const endText = lines[end.line] ?? '';
    if (!startText.slice(0, start.character).trim()) start = { line: start.line, character: 0 };
    if (!endText.slice(end.character).trim()) end = { line: end.line, character: endText.length };
    const before = start.character > 0 ? '\n' : '';
    const after = end.character < endText.length ? '\n' : '';
    change = { range: { start, end }, text: before + text + after };
    startLine = start.line + (before ? 1 : 0);
  }
  const imported = importChange(importEdit);
  const inside =
    imported &&
    comparePositions(imported.range.start, change.range.start) > 0 &&
    comparePositions(imported.range.start, change.range.end) < 0;
  const insertion = inside ? null : imported;
  const shift =
    insertion && comparePositions(insertion.range.start, change.range.start) <= 0
      ? insertion.text.split(LINE_BREAK).length - 1
      : 0;
  const first = { line: startLine + shift, character: 0 };
  return {
    changes: insertion ? [insertion, change] : [change],
    block: { start: first, end: endOfInsert(first, text) },
  };
}

/** A button of a recording's controls: the command it runs, with the session's id as its argument. */
export interface RecordingAction {
  title: string;
  command: 'piwi.stopRecording' | 'piwi.pauseRecording' | 'piwi.resumeRecording';
}

/** What the controls above the recorded block and the status bar item show while a recording runs. */
export interface RecordingView {
  /** The first control: the state and the step count. */
  title: string;
  actions: RecordingAction[];
  status: string;
  tooltip: string;
}

/**
 * The controls of a running recording, from the service's state, the step count, and whether it is paused because
 * the block was edited (`edited`), which takes precedence. `file` is the name of the file it writes into.
 */
export function recordingView(
  state: RecordingUpdate['state'],
  steps: number,
  edited: boolean,
  file: string,
): RecordingView {
  const count = plural(steps, 'step');
  const stop: RecordingAction = { title: 'Stop', command: 'piwi.stopRecording' };
  const resume: RecordingAction = { title: 'Resume', command: 'piwi.resumeRecording' };
  if (edited) {
    return {
      title: `$(debug-pause) Paused while you edit · ${count}`,
      actions: [resume, { title: 'Keep my edits', command: 'piwi.stopRecording' }],
      status: `$(debug-pause) Piwi: paused · ${count}`,
      tooltip: `The recording into ${file} is paused: you edited the recorded block. Click to stop and keep your edits.`,
    };
  }
  if (state === 'paused') {
    return {
      title: `$(debug-pause) Paused · ${count}`,
      actions: [stop, resume],
      status: `$(debug-pause) Piwi: paused · ${count}`,
      tooltip: `The recording into ${file} is paused. Click to stop.`,
    };
  }
  if (state === 'starting') {
    return {
      title: '$(loading~spin) Opening the browser',
      actions: [stop],
      status: '$(loading~spin) Piwi: opening the browser',
      tooltip: `Recording into ${file}. Click to stop.`,
    };
  }
  return {
    title: `$(record) Recording · ${count}`,
    actions: [stop, { title: 'Pause', command: 'piwi.pauseRecording' }],
    status: `$(record) Piwi: recording · ${count}`,
    tooltip: `Recording into ${file}. Click to stop.`,
  };
}

/**
 * Where a recording started at a position writes, from where `piwi/pageCandidates` says the position is: outside every
 * test, function and class, a new test (`test`); anywhere else, the steps there (`steps`), which the editor service
 * refuses where they cannot go.
 */
export function recordInto(context: string): 'steps' | 'test' {
  return context === 'file' ? 'test' : 'steps';
}

/**
 * The notification after a recording stopped: what was written into `file`, or that the block keeps the edits made
 * in it.
 */
export function recordingSummary(
  update: Pick<RecordingUpdate, 'steps' | 'warnings' | 'message'>,
  keptEdits: boolean,
  file: string,
): string {
  if (keptEdits) return 'Piwi: recording stopped. The recorded block keeps your edits.';
  const warnings = update.warnings.length;
  const check = warnings ? `, ${plural(warnings, 'warning')} to check` : '';
  const written = update.steps.length
    ? `recorded ${plural(update.steps.length, 'step')} into ${file}${check}`
    : `nothing was recorded into ${file}`;
  const message = update.message?.trim();
  if (!message) return `Piwi: ${written}.`;
  return `Piwi: ${/[.!?]$/.test(message) ? message : `${message}.`} ${written[0]!.toUpperCase()}${written.slice(1)}.`;
}

/** The actions the notification after a recording offers for the test that holds the block. */
export const RECORDED_ACTIONS = { run: 'Run', verify: 'Verify ×3' } as const;

/** How many times **Verify ×3** runs a test. */
export const VERIFY_REPEAT = 3;

/** A line of a spec: the argument the notification after a recording gives the run commands. */
export interface TestLine {
  uri: string;
  /** 0-based. */
  line: number;
}

/** The line a run command's argument names; null for anything else, such as the file a context menu passes. */
export function testLineArg(arg: unknown): TestLine | null {
  const at = arg as Partial<TestLine> | null | undefined;
  return typeof at?.uri === 'string' && typeof at.line === 'number' && at.line >= 0
    ? { uri: at.uri, line: at.line }
    : null;
}

/**
 * What runs the test `piwi/testAt` found at a line of the spec at `uri`: by its id when Piwi knows it, else by its
 * location; with `repeat`, by its location, that many times. Null outside every test.
 */
export function testAtRun(uri: string, found: TestAtResult | null, repeat?: number): RunTestsArgs | null {
  if (found?.test && !repeat) return { uri, testIds: [found.test.id] };
  if (!found?.location) return null;
  return { uri, testIds: [], locations: [found.location], ...(repeat ? { repeat } : {}) };
}

/** A Playwright test file's name: `.spec` or `.test`, then a JavaScript or TypeScript extension. */
export const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/** The `testDir` a Playwright config names as a string literal; null when it names none that way. */
export function configTestDir(config: string): string | null {
  return /\btestDir\s*:\s*(['"`])([^'"`]+)\1/.exec(config)?.[2] ?? null;
}

/**
 * The name offered for a new test file, with the suffix of `sample`: a test file's own (`.test.js`), else `.spec.js`
 * beside a JavaScript Playwright config, else `.spec.ts`.
 */
export function newTestFileName(sample: string | null): string {
  const suffix =
    (sample && TEST_FILE.exec(sample)?.[0]) || (sample && /\.[cm]?js$/.test(sample) ? '.spec.js' : '.spec.ts');
  return `recorded${suffix}`;
}

/**
 * One run of `fn` for the calls made until `schedule` runs it: the first call schedules the run, the later ones join
 * it, and a call once it ran schedules the next.
 */
export function coalesced(fn: () => void, schedule: (run: () => void) => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      fn();
    });
  };
}

/** The longest name a test run's task gets: the start of `playwright test` and its arguments. */
const TASK_NAME_LENGTH = 80;

/** The name of a test run's task: `playwright test` and its arguments, cut at `TASK_NAME_LENGTH` characters. */
export function runTaskName(args: readonly string[]): string {
  const name = ['playwright test', ...args].join(' ');
  return name.length > TASK_NAME_LENGTH ? `${name.slice(0, TASK_NAME_LENGTH - 1)}…` : name;
}

/**
 * What a `vscode://piwitests.piwi/open` link names: the file as the run reported it, its 1-based line and column, and
 * the folder the file is relative to, when the dashboard knows it.
 */
export interface OpenLink {
  file: string;
  line: number;
  column: number;
  root: string | null;
}

/**
 * An open link's query as `vscode.Uri.query` gives it, decoded: `file=…&line=…&column=…&root=…`, each value taken as
 * written up to the next `&` that starts one of these keys, so a path may hold an `&`. A line or column missing or
 * below 1 is 1. Null without a file.
 */
export function openLink(query: string): OpenLink | null {
  const params = new Map<string, string>();
  for (const pair of query.split(/&(?=(?:file|line|column|root)=)/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) params.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const file = params.get('file')?.trim();
  if (!file) return null;
  const position = (name: string) => {
    const n = Number.parseInt(params.get(name) ?? '', 10);
    return Number.isInteger(n) && n >= 1 ? n : 1;
  };
  return { file, line: position('line'), column: position('column'), root: params.get('root')?.trim() || null };
}

/** Whether `file` is `folder` or inside it. */
function within(folder: string, file: string): boolean {
  return path.relative(folder, file) === '' || isUnder(folder, file);
}

/**
 * The file an open link names, found as the editor service finds a run's path: an absolute path as given, else joined
 * to each folder, then by ever shorter suffixes (at least the file and its directory). The folders are the link's
 * `root` when it lies in a workspace folder, then the Playwright configs' folders, then the workspace folders. Only a
 * file inside a workspace folder is returned; null when none exists. `exists` says whether a path is a file.
 */
export function resolveOpenFile(
  link: Pick<OpenLink, 'file' | 'root'>,
  places: { workspaceFolders: readonly string[]; configRoots: readonly string[] },
  exists: (file: string) => boolean,
): string | null {
  const found = (file: string) => places.workspaceFolders.some((folder) => within(folder, file)) && exists(file);
  const reported = link.file.replace(/\\/g, '/');
  if (path.isAbsolute(reported) && found(path.resolve(reported))) return path.resolve(reported);
  const root = link.root ? path.resolve(link.root) : null;
  const roots = [
    ...(root && places.workspaceFolders.some((folder) => within(folder, root)) ? [root] : []),
    ...places.configRoots,
    ...places.workspaceFolders,
  ];
  const parts = reported.split('/').filter((p) => p && p !== '.');
  for (const folder of new Set(roots)) {
    for (let from = 0; parts.length - from >= Math.min(2, parts.length); from++) {
      const candidate = path.join(folder, ...parts.slice(from));
      if (found(candidate)) return candidate;
    }
  }
  return null;
}

/** The message shown when an open link names no file of this window. */
export function openLinkMissing(file: string): string {
  return `Piwi: no file of this window matches ${file}. VS Code opens a link in the window focused last: focus the window of the project that holds it, then open the link again.`;
}

/** The editor's proxy settings, `http.*` in VS Code's configuration, which the editor service follows. */
export interface ProxySettings {
  /** `http.proxy`: the proxy's URL; empty, the environment's own variables apply. */
  proxy?: string | null;
  /** `http.proxyStrictSSL`: whether certificates are verified. */
  proxyStrictSSL?: boolean | null;
  /** `http.proxyAuthorization`: the value of the `Proxy-Authorization` header. */
  proxyAuthorization?: string | null;
  /** `http.noProxy`: the hosts reached without the proxy. */
  noProxy?: string[] | null;
}

/** The proxy's URL with a `Basic` authorization as its credentials, when it has none of its own; else as given. */
function proxyUrl(proxy: string, authorization: string | null | undefined): string {
  const basic = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(authorization?.trim() ?? '');
  if (!basic) return proxy;
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return proxy;
  }
  const credential = Buffer.from(basic[1], 'base64').toString('utf-8');
  const colon = credential.indexOf(':');
  if (url.username || url.password || colon < 0) return proxy;
  url.username = credential.slice(0, colon);
  url.password = credential.slice(colon + 1);
  return url.href;
}

/**
 * The environment the editor service starts with: the editor's, `env`, with its proxy settings as the variables the
 * service reaches an instance through: `HTTPS_PROXY` and `HTTP_PROXY` from `http.proxy`, a `Basic`
 * `http.proxyAuthorization` folded in as its credentials, `NO_PROXY` from `http.noProxy`, and
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` while `http.proxyStrictSSL` is off. A setting left empty keeps the environment's
 * own variable, as it does for the editor. A private certificate authority reaches the service as
 * `NODE_EXTRA_CA_CERTS` in `env`.
 */
export function serviceEnvironment(settings: ProxySettings, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  const proxy = settings.proxy?.trim();
  if (proxy) {
    const url = proxyUrl(proxy, settings.proxyAuthorization);
    // The lower-case variables come first for Node: a setting replaces them.
    delete result.https_proxy;
    delete result.http_proxy;
    result.HTTPS_PROXY = url;
    result.HTTP_PROXY = url;
  }
  const noProxy = (settings.noProxy ?? []).map((host) => host.trim()).filter(Boolean);
  if (noProxy.length) {
    delete result.no_proxy;
    result.NO_PROXY = noProxy.join(',');
  }
  if (settings.proxyStrictSSL === false) result.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return result;
}
