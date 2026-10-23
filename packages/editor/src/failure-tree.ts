/**
 * The failures tree both editor clients draw (`FailuresResult.tree`): the run, the runs laid over it, and the
 * failures grouped by spec, failure cluster or owner, or flat, under one node per Playwright config when several have
 * something to show; with the count of the tests still failing and what **Re-run the failing tests** runs. Pure: the
 * clients add a run's age and the editor's own run in progress.
 */
import type {
  FailuresGrouping,
  FailuresOverlay,
  FailuresResult,
  FailuresRun,
  FailureTreeIcon,
  FailureTreeNode,
  RunTestsArgs,
  WorkspaceFailure,
} from './protocol.js';

export const FAILURES_GROUPINGS: readonly FailuresGrouping[] = ['file', 'cluster', 'owner', 'flat'];

/** A grouping a client asked for; null when it is not one. */
export function parseFailuresGrouping(value: unknown): FailuresGrouping | null {
  return FAILURES_GROUPINGS.includes(value as FailuresGrouping) ? (value as FailuresGrouping) : null;
}

/** The order of a failure's state in its group: failing first, then edited, then fixed locally. */
const STATE_ORDER: Record<string, number> = { failing: 0, edited: 1, 'fixed-locally': 2 };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What launched a run, in a few words: `CI`, `your run`, `local`, `desktop app`, `editor`. */
function originLabel(origin: string | undefined, own: boolean | undefined): string {
  if (own) return 'your run';
  if (!origin || origin === 'ci' || origin === 'ci-rerun') return 'CI';
  return origin === 'desktop' ? 'desktop app' : origin;
}

/** The test a failure stands for: its id, else its title in its file. */
function testKey(f: WorkspaceFailure): string {
  return f.testCaseId !== undefined ? String(f.testCaseId) : `${f.file ?? f.uri}\n${f.title}`;
}

/** Whether a failure still fails: failing, or edited since its run. */
function stillFails(f: WorkspaceFailure): boolean {
  return f.state !== 'fixed-locally';
}

/** `3 failing · 1 fixed locally`, counting tests: a test failing on several projects counts once. */
function failureCounts(items: WorkspaceFailure[]): string {
  const failing = new Set(items.filter(stillFails).map(testKey)).size;
  const fixed = new Set(items.filter((f) => !stillFails(f)).map(testKey)).size;
  return [failing || !fixed ? `${failing} failing` : null, fixed ? `${fixed} fixed locally` : null]
    .filter(Boolean)
    .join(' · ');
}

/** How many tests still fail among the failures, edited since their run or not. */
export function failingCount(items: WorkspaceFailure[]): number {
  return new Set(items.filter(stillFails).map(testKey)).size;
}

/**
 * What a failure says about its run: `fixed locally in run #124` for a failure a later run passed (`fixed in run #124`
 * when that run is a CI run, `fixed locally in your run #124` when the editor started it), `edited since run #120` for a
 * failure whose line changed since its run (`edited since your run #124`, `edited since local run #124`), `your run
 * #124` for a failure of a run the editor started, `local run #124` for a failure of another run that did not run in
 * CI, `run #120` otherwise.
 */
export function failureRunNote(f: WorkspaceFailure): string {
  const run =
    f.source === 'own' ? `your run #${f.runId}` : f.source === 'local' ? `local run #${f.runId}` : `run #${f.runId}`;
  if (f.state === 'fixed-locally') {
    if (f.source === 'ci') return `fixed in run #${f.runId}`;
    return f.source === 'own' ? `fixed locally in your run #${f.runId}` : `fixed locally in run #${f.runId}`;
  }
  return f.state === 'edited' ? `edited since ${run}` : run;
}

/** The name of the file a `file:` URI names. */
function fileName(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
}

/** The file a failure shows in, at its line: the spec's path when it shows in the spec, else the file's name. */
function failurePlace(f: WorkspaceFailure): string {
  const shown = f.file && decodeURIComponent(f.uri).endsWith(`/${f.file}`) ? f.file : fileName(f.uri);
  return `${shown}:${f.line + 1}`;
}

function failureLeaf(f: WorkspaceFailure, runId: number | null): FailureTreeNode {
  const icon: FailureTreeIcon = f.state === 'fixed-locally' ? 'fixed' : f.state === 'edited' ? 'edited' : 'failing';
  const note = failureRunNote(f);
  return {
    key: `failure:${f.executionId}`,
    kind: 'failure',
    label: f.title,
    description: [failurePlace(f), f.browserName, f.isNew && stillFails(f) ? 'new' : null].filter(Boolean).join(' · '),
    tooltip: [
      f.title,
      f.headline,
      note,
      f.status === 'timedOut' ? 'Timed out' : null,
      f.clusterTitle ? `Cluster: ${f.clusterTitle}` : null,
      f.owner ? `Owner: ${f.owner}` : null,
    ].filter((line): line is string => !!line),
    note: f.state === 'failing' && f.source === 'ci' && f.runId === runId ? null : note,
    icon,
    expanded: false,
    url: f.url,
    executionId: f.executionId,
    children: [],
  };
}

function sortFailures(items: WorkspaceFailure[]): WorkspaceFailure[] {
  return [...items].sort(
    (a, b) =>
      (STATE_ORDER[a.state ?? 'failing'] ?? 0) - (STATE_ORDER[b.state ?? 'failing'] ?? 0) ||
      (a.file ?? a.uri).localeCompare(b.file ?? b.uri) ||
      a.line - b.line ||
      a.title.localeCompare(b.title),
  );
}

/** The group a failure goes in: its key, which ends with `:` for the group of those without a value, and its label. */
function groupOf(f: WorkspaceFailure, grouping: Exclude<FailuresGrouping, 'flat'>): { key: string; label: string } {
  if (grouping === 'file') {
    const file = f.file ?? fileName(f.uri);
    return { key: `file:${file}`, label: file };
  }
  if (grouping === 'cluster') {
    if (f.clusterId === null || f.clusterId === undefined) return { key: 'cluster:', label: 'Ungrouped' };
    return { key: `cluster:${f.clusterId}`, label: f.clusterTitle?.trim() || `Cluster #${f.clusterId}` };
  }
  const owner = f.owner?.trim();
  return owner ? { key: `owner:${owner}`, label: owner } : { key: 'owner:', label: 'Unowned' };
}

/** The groups of the failures, by label, the group of those without a value last. */
function grouped(items: WorkspaceFailure[], grouping: FailuresGrouping, runId: number | null): FailureTreeNode[] {
  if (grouping === 'flat') return sortFailures(items).map((f) => failureLeaf(f, runId));
  const groups = new Map<string, { label: string; items: WorkspaceFailure[] }>();
  for (const f of items) {
    const { key, label } = groupOf(f, grouping);
    const group = groups.get(key) ?? groups.set(key, { label, items: [] }).get(key)!;
    group.items.push(f);
  }
  return [...groups]
    .sort(([a, x], [b, y]) => Number(a.endsWith(':')) - Number(b.endsWith(':')) || x.label.localeCompare(y.label))
    .map(([key, group]) => ({
      key: `group:${key}`,
      kind: 'group' as const,
      label: group.label,
      description: failureCounts(group.items),
      tooltip: [group.label],
      icon: grouping,
      expanded: true,
      url: null,
      children: sortFailures(group.items).map((f) => failureLeaf(f, runId)),
    }));
}

/**
 * The failures a tree is built from: `piwi/failures`'s items, run, runs laid over it and baseline, and the folder of
 * the Playwright config they belong to, which the run's node names (`root`).
 */
export type FailuresInput = Pick<FailuresResult, 'items' | 'run' | 'overlays' | 'baseline'> & { root?: string };

/** One context's failures, as `failuresAnswer` reads them: with what names its node, and when its run was read. */
export interface ContextFailures extends FailuresInput {
  root: string;
  /** Its folder as the editor names it (`contextLabel`). */
  label: string;
  projectName?: string | null;
  /** ISO 8601. */
  updatedAt?: string;
}

/** The baseline a context compares with, as the run's tooltip names it: `Baseline: CI run #120 on main`. */
function baselineLine(label: string | undefined): string | null {
  return label?.trim() ? `Baseline: ${label}` : null;
}

/**
 * The run as the tree's `run` node names it: `Run #120 · CI · feature/x · 3 failing · 1 fixed locally`, `Your local
 * runs · 1 failing` with a developer's own runs alone; null without a run.
 */
export function runLabel(view: FailuresInput): string | null {
  const run = view.run;
  if (run) {
    return [`Run #${run.id}`, originLabel(run.origin, run.own), run.branch, failureCounts(view.items)]
      .filter(Boolean)
      .join(' · ');
  }
  return view.overlays?.length ? `Your local runs · ${failureCounts(view.items)}` : null;
}

function overlayNode(o: FailuresOverlay): FailureTreeNode {
  return {
    key: `overlay:${o.id}`,
    kind: 'overlay',
    label: [`#${o.id}`, o.own ? 'your run' : null, `${o.passedTests} passed, ${o.failedTests} failed`]
      .filter(Boolean)
      .join(' · '),
    description: '',
    startTime: o.startTime,
    tooltip: [
      `Run #${o.id}, ${originLabel(o.origin, o.own)}: ${o.passedTests} passed, ${o.failedTests} failed of ${o.totalTests}`,
    ],
    icon: o.failedTests ? 'failed' : 'passed',
    expanded: false,
    url: o.url,
    children: [],
  };
}

function runSummary(run: FailuresRun): string {
  return `Run #${run.id}${run.branch ? ` of ${run.branch}` : ''}: ${run.passedTests} passed, ${run.failedTests} failed, ${run.flakyTests} flaky, ${run.skippedTests} skipped`;
}

/**
 * The run's node over `children`: the baseline run (its tooltip naming the baseline chosen, `Baseline: CI run #120 on
 * feature/x`), with the runs laid over it under `Your runs since`; `Your local runs` with a developer's own runs alone.
 * Null without a run, and with runs laid over none but no baseline named (an older service).
 */
function runNode(view: FailuresInput, children: FailureTreeNode[]): FailureTreeNode | null {
  const run = view.run ?? null;
  const overlays = view.overlays ?? [];
  const baseline = baselineLine(view.baseline?.label);
  const label = runLabel(view);
  if (!label || (!run && !baseline)) return null;
  const runs: FailureTreeNode[] = overlays.length
    ? [
        {
          key: 'runs',
          kind: 'runs',
          label: run ? 'Your runs since' : 'Your runs',
          description: plural(overlays.length, 'run'),
          tooltip: [
            run
              ? `The runs of ${run.branch ?? 'the branch'} since run #${run.id}, laid over it test by test`
              : 'Your runs of the branch, newest first, laid over one another test by test',
          ],
          icon: 'history',
          expanded: false,
          url: null,
          children: overlays.map(overlayNode),
        },
      ]
    : [];
  return {
    key: 'run',
    kind: 'run',
    label,
    description: run ? '' : 'no baseline',
    startTime: run?.startTime ?? null,
    tooltip: [baseline, run ? runSummary(run) : null].filter((line): line is string => !!line),
    icon: 'run',
    expanded: true,
    url: run?.url ?? null,
    ...(view.root ? { root: view.root } : {}),
    children: [...runs, ...children],
  };
}

/**
 * The failures tree: the run's node (`runNode`) over the failures grouped by file, cluster or owner, or flat, failing
 * first, then edited, then fixed locally. Without a run (an older instance), the groups alone; without a failure,
 * nothing.
 */
export function failureTree(view: FailuresInput, grouping: FailuresGrouping): FailureTreeNode[] {
  const items = view.items;
  if (!items.length) return [];
  const groups = grouped(items, grouping, view.run?.id ?? null);
  const run = runNode(view, groups);
  return run ? [run] : groups;
}

/** Whether a context has something for the failures tree: a run, runs laid over none, or failures. */
function showsSomething(view: FailuresInput): boolean {
  return !!view.run || !!view.overlays?.length || view.items.length > 0;
}

/**
 * A context's node: its folder (`apps/admin`), its project and its counts, over its failures tree, or its run alone
 * without a failure. The keys under it are its own and theirs, on two lines, so that no two nodes share one.
 */
function contextNode(view: ContextFailures, grouping: FailuresGrouping): FailureTreeNode {
  const key = `context:${view.root}`;
  const run = view.items.length ? null : runNode(view, []);
  const children = run ? [run] : failureTree(view, grouping);
  const within = (node: FailureTreeNode): FailureTreeNode => ({
    ...node,
    key: `${key}\n${node.key}`,
    children: node.children.map(within),
  });
  return {
    key,
    kind: 'context',
    label: view.label,
    description: [view.projectName, failureCounts(view.items)].filter(Boolean).join(' · '),
    tooltip: [
      `Playwright config in ${view.root}`,
      view.projectName ? `Project: ${view.projectName}` : null,
      runLabel(view),
      baselineLine(view.baseline?.label),
    ].filter((line): line is string => !!line),
    icon: 'context',
    expanded: true,
    url: view.run?.url ?? null,
    root: view.root,
    children: children.map(within),
  };
}

/**
 * What **Re-run the failing tests** runs: every test still failing or edited since its run, one run per Playwright
 * config (`WorkspaceFailure.root`), in the order of their first failure; none when none fails.
 */
export function rerunFailingArgs(items: WorkspaceFailure[]): RunTestsArgs[] {
  const runs = new Map<string, RunTestsArgs>();
  for (const f of items.filter(stillFails)) {
    if (f.testCaseId === undefined) continue;
    const key = f.root ?? '';
    const run =
      runs.get(key) ?? runs.set(key, { uri: f.uri, ...(f.root ? { root: f.root } : {}), testIds: [] }).get(key)!;
    if (!run.testIds.includes(f.testCaseId)) run.testIds.push(f.testCaseId);
  }
  return [...runs.values()];
}

/** What `piwi/failures` adds to the failures: the tree in `grouping`, the run's label, the count and the re-run. */
export function failuresDrawn(
  view: FailuresInput,
  grouping: FailuresGrouping,
): Pick<FailuresResult, 'grouping' | 'tree' | 'runLabel' | 'failing' | 'rerun'> {
  return {
    grouping,
    tree: failureTree(view, grouping),
    runLabel: runLabel(view),
    failing: failingCount(view.items),
    rerun: rerunFailingArgs(view.items),
  };
}

/**
 * `piwi/failures` from each context's failures: the failures of all, the count and the re-run, and the tree. With one
 * context that has a run, runs laid over none or failures, its tree, run, runs, baseline and when it was read, as
 * `failuresDrawn` gives them; with several, one node per context (`contextNode`), in the contexts' order, and no run,
 * runs or baseline beside them.
 */
export function failuresAnswer(contexts: ContextFailures[], grouping: FailuresGrouping): FailuresResult {
  const items = contexts.flatMap((c) => c.items);
  const shown = contexts.filter(showsSomething);
  if (shown.length > 1) {
    const read = shown.flatMap((c) => (c.updatedAt ? [c.updatedAt] : [])).sort();
    return {
      items,
      ...(read.length ? { updatedAt: read[read.length - 1] } : {}),
      grouping,
      tree: shown.map((c) => contextNode(c, grouping)),
      runLabel: null,
      failing: failingCount(items),
      rerun: rerunFailingArgs(items),
    };
  }
  const one = shown[0];
  if (!one || (!one.run && !one.overlays?.length)) return { items, ...failuresDrawn({ items }, grouping) };
  const view = {
    items,
    run: one.run ?? null,
    overlays: one.overlays ?? [],
    ...(one.baseline ? { baseline: one.baseline } : {}),
    ...(one.updatedAt ? { updatedAt: one.updatedAt } : {}),
  };
  return { ...view, ...failuresDrawn({ ...view, root: one.root }, grouping) };
}
