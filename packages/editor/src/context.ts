/**
 * One Playwright config of the workspace and what the editor service knows
 * about it: the instance and project it reports to, the branch it reads, and
 * the project's indexes, fetched in the background and refreshed on a timer.
 * Nothing here blocks typing: a request answers from what is cached.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDotEnv, resolvePiwiConnection, type PiwiConnection } from '@piwitests/core/dotenv';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import type { LocatorHealingResult } from '@piwitests/core/locator-healing-types';
import {
  PiwiClient,
  PiwiHttpError,
  type ResponseCache,
  type BranchFailures,
  type CallSiteAlternatives,
  type CatalogCase,
  type CodeIndex,
  type BranchFailure,
  type EntityLink,
  type FileCoverage,
  type FixPlan,
  type FlakeLabEntry,
  type FlakyTest,
  type QuarantinedTest,
} from './piwi-client.js';
import type { TimeoutAdvice } from './analysis.js';
import type {
  BaselineChoice,
  ConnectionSource,
  EditorCredentials,
  LiveRun,
  LiveTestStatus,
  ProblemKind,
} from './protocol.js';
import {
  committedText,
  committedTextAt,
  currentBranch,
  headCommit,
  reporterVersion,
  repositoryRoot,
  translationValues,
} from './workspace.js';

/** Selections resolved at each refresh, at most. */
const MAX_SELECTIONS = 20;

/** How long per-file answers (catalog, alternatives) are reused. */
const FILE_CACHE_MS = 5 * 60_000;

/** The files whose coverage a context keeps at most; the least recently asked goes first. */
const MAX_COVERAGES = 200;

/** The origins of CI runs, as `branch-failures` names them. */
export const CI_ORIGINS = new Set(['ci', 'ci-rerun']);

/** The origins of a developer's own runs: their machine, the desktop app, an editor. */
const LOCAL_ORIGINS = new Set(['local', 'desktop', 'editor']);

/** The answer of a baseline that found no run. */
const noRun = (): BranchFailures => ({ run: null, overlays: [], failures: [], resolved: [] });

/**
 * A file's coverage as last read: the answer (null for none: the instance has no coverage route, or refused the
 * request), the `ETag` it came with, and the read on its way. `stale` reads it again on the next ask; `again` reads it
 * once more after the read on its way, which started before what made it stale.
 */
interface CoverageEntry {
  value: FileCoverage | null;
  etag: string | null;
  read: Promise<FileCoverage | null> | null;
  stale: boolean;
  again: boolean;
}

/** A file as a commit holds it: the commit, its text once read (null when the repository has none), and the read. */
interface CommitText {
  commit: string;
  text: string | null | undefined;
  read: Promise<string | null>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function readDotEnv(dir: string): Record<string, string> {
  try {
    return parseDotEnv(fs.readFileSync(path.join(dir, '.env'), 'utf-8'));
  } catch {
    return {};
  }
}

/** Where the desktop app publishes its address, token and folder links while it runs. */
export function desktopConfigPath(env: Record<string, string | undefined>): string {
  return env.PIWI_DESKTOP_CONFIG || path.join(os.homedir(), '.piwi', 'desktop.json');
}

export interface DesktopDiscovery {
  url: string;
  token: string;
  /** The projects linked to a folder on this machine in the desktop app. */
  projects: Array<{ id: number; path: string }>;
}

/** The running desktop app, from its discovery file; null when it does not run. */
export function readDesktopDiscovery(env: Record<string, string | undefined>): DesktopDiscovery | null {
  const discovery = readJson(desktopConfigPath(env)) as { url?: unknown; token?: unknown; projects?: unknown } | null;
  if (!discovery || typeof discovery.url !== 'string' || typeof discovery.token !== 'string') return null;
  const projects = Array.isArray(discovery.projects)
    ? discovery.projects.flatMap((p: { id?: unknown; path?: unknown }) =>
        typeof p?.id === 'number' && typeof p.path === 'string' && p.path ? [{ id: p.id, path: p.path }] : [],
      )
    : [];
  return { url: discovery.url.replace(/\/+$/, ''), token: discovery.token, projects };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The project the desktop app links to this context's folder: the linked folder
 * that holds the Playwright config, or one inside it; the deepest wins.
 */
export function linkedDesktopProject(desktop: DesktopDiscovery | null, root: string): number | null {
  const matches = (desktop?.projects ?? [])
    .filter((p) => isInside(root, p.path) || isInside(p.path, root))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.id ?? null;
}

function linkedProject(desktop: DesktopDiscovery | null, root: string): string {
  const id = linkedDesktopProject(desktop, root);
  return id === null ? '' : String(id);
}

type ContextConnection = PiwiConnection & { source: ConnectionSource };

/** A baseline choice as a client sent it; null when it is not one. */
export function parseBaselineChoice(value: unknown): BaselineChoice | null {
  const choice = value as { kind?: unknown; branch?: unknown; runId?: unknown } | null;
  if (!choice || typeof choice !== 'object') return null;
  if (choice.kind === 'ladder' || choice.kind === 'local') return { kind: choice.kind };
  if (choice.kind === 'branch' && typeof choice.branch === 'string' && choice.branch.trim()) {
    return { kind: 'branch', branch: choice.branch.trim() };
  }
  if (choice.kind === 'run' && Number.isInteger(choice.runId) && (choice.runId as number) > 0) {
    return { kind: 'run', runId: choice.runId as number };
  }
  return null;
}

/**
 * A baseline in a few words: the run it found (`CI run #120 on feature/x`, `local run #110 on feature/x`, `run #118`
 * from an instance that does not say what launched it), `your local runs only` for a developer's own runs, and the
 * choice followed by `(no run)` when it found none. `branch` is the branch read.
 */
export function baselineLabel(choice: BaselineChoice, answer: BranchFailures | null, branch: string | null): string {
  const run = answer?.run;
  const name = run
    ? `${!run.origin ? '' : CI_ORIGINS.has(run.origin) ? 'CI ' : 'local '}run #${run.id}${run.branch ? ` on ${run.branch}` : ''}`
    : null;
  switch (choice.kind) {
    case 'branch':
      return name ?? `${choice.branch} (no run)`;
    case 'run':
      return name ?? `run #${choice.runId} (no run)`;
    case 'local':
      if (name) return `your local runs only: ${name}`;
      return answer?.overlays?.length
        ? 'your local runs only'
        : `your local runs only${branch ? ` on ${branch}` : ''} (no run)`;
    default:
      if (!name) return 'the newest run of any branch (no run)';
      return branch ? name : `${name}, the newest run of any branch`;
  }
}

/**
 * The instance the environment, the workspace `.env` (the config's directory,
 * then the repository root) or the instance saved with Connect in the editor
 * name, in that order; null when none does.
 */
export function namedInstance(
  root: string,
  repoRoot: string,
  env: Record<string, string | undefined>,
  editor: EditorCredentials,
  desktop: DesktopDiscovery | null = readDesktopDiscovery(env),
): ContextConnection | null {
  const dotEnv = { ...readDotEnv(repoRoot), ...readDotEnv(root) };
  if (env.PIWI_DASHBOARD_URL || dotEnv.PIWI_DASHBOARD_URL) {
    const found = resolvePiwiConnection({ env, dotEnv, desktop })!;
    // The key saved in the editor belongs to the server it was saved for: a URL
    // from the environment or a workspace `.env` never gets another's.
    const editorUrl = editor.serverUrl?.replace(/\/+$/, '');
    return {
      serverUrl: found.serverUrl,
      apiKey: found.apiKey ?? (editorUrl === found.serverUrl ? (editor.apiKey ?? null) : null),
      project:
        found.project || editor.project || (desktop?.url === found.serverUrl ? linkedProject(desktop, root) : ''),
      source: env.PIWI_DASHBOARD_URL ? 'environment' : 'dotenv',
    };
  }
  if (editor.serverUrl) {
    return {
      serverUrl: editor.serverUrl.replace(/\/+$/, ''),
      apiKey: editor.apiKey ?? null,
      project: editor.project || env.PIWI_PROJECT_NAME || dotEnv.PIWI_PROJECT_NAME || '',
      source: 'editor',
    };
  }
  return null;
}

/**
 * The connection of a context: the desktop app running on this machine when
 * the editor chose it with Connect, else the named instance (`namedInstance`),
 * else the desktop app while it runs. The editor's choice of the app comes
 * first: it is made on this machine, and the app is this machine's own.
 *
 * With the app chosen, the project is the one picked with Connect, else the one
 * the app links to this folder, else `PIWI_PROJECT_NAME`, which names the
 * project of the instance the reporter sends to. Reached because nothing else
 * names an instance, the app is where the reporter sends too: the project is the
 * one `PIWI_PROJECT_NAME` or the editor names, else the linked one.
 */
export function resolveContextConnection(
  root: string,
  repoRoot: string,
  env: Record<string, string | undefined>,
  editor: EditorCredentials,
): ContextConnection | null {
  const desktop = readDesktopDiscovery(env);
  const named = namedInstance(root, repoRoot, env, editor, desktop);
  if (!desktop || (named && !editor.desktop)) return named;
  const dotEnv = { ...readDotEnv(repoRoot), ...readDotEnv(root) };
  const namedProject = env.PIWI_PROJECT_NAME || dotEnv.PIWI_PROJECT_NAME || '';
  const linked = linkedProject(desktop, root);
  return {
    serverUrl: desktop.url,
    apiKey: desktop.token,
    project: editor.desktop
      ? editor.desktopProject || linked || namedProject
      : namedProject || editor.project || linked,
    source: 'desktop',
  };
}

/** The owners a repository's CODEOWNERS file names: `@team`, `@user`, emails. */
function codeOwners(repoRoot: string): string[] {
  const owners = new Set<string>();
  for (const file of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const fields = line.replace(/#.*$/, '').trim().split(/\s+/).slice(1);
      for (const f of fields) if (/^@[\w./-]+$/.test(f) || /^[^@\s]+@[^@\s]+$/.test(f)) owners.add(f);
    }
  }
  return [...owners].sort();
}

/**
 * A `piwi` command line that reports to `serverUrl` when run from `root`: the
 * command itself when it would find that instance there on its own (the
 * environment, the `.env` beside the config, the desktop app), whose key it
 * then reads too; else with `--server-url`.
 */
export function withServerUrl(
  command: string,
  serverUrl: string,
  root: string,
  env: Record<string, string | undefined>,
  desktop: DesktopDiscovery | null = readDesktopDiscovery(env),
): string {
  const own = resolvePiwiConnection({ env, dotEnv: readDotEnv(root), desktop });
  const target = serverUrl.replace(/\/+$/, '');
  return own?.serverUrl === target ? command : `${command} --server-url ${target}`;
}

/**
 * `ask`'s answer, kept in `cache` under `key` and shared by the asks meanwhile. A failure answers `fallback`; it is
 * kept when the instance refused the request itself (a 4xx but 408 and 429: none, or not allowed), and asked again
 * next time otherwise (no answer, or an error of the instance).
 */
function once<K, V>(cache: Map<K, Promise<V>>, key: K, ask: () => Promise<V>, fallback: V): Promise<V> {
  let found = cache.get(key);
  if (!found) {
    const asked: Promise<V> = ask().catch((e: unknown) => {
      const refused = e instanceof PiwiHttpError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status);
      if (!refused && cache.get(key) === asked) cache.delete(key);
      return fallback;
    });
    found = asked;
    cache.set(key, found);
  }
  return found;
}

/** Where stored files (traces, screenshots) are downloaded, one folder per instance and path. */
export const EVIDENCE_ROOT = path.join(os.tmpdir(), 'piwi-editor');
/** A downloaded file not used for this long is deleted. */
const EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Delete the downloaded files not used for a week. Never throws. */
export async function pruneEvidence(root = EVIDENCE_ROOT, now = Date.now()): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const stat = await fs.promises.stat(dir).catch(() => null);
    if (stat && now - stat.mtimeMs > EVIDENCE_MAX_AGE_MS) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export class PiwiContext {
  repoRoot: string;
  client: PiwiClient | null = null;
  /** Where the client's instance came from; null without one. */
  source: ConnectionSource | null = null;
  /** The instance the environment, the `.env` or the editor's settings name, in use or not. */
  instance: { serverUrl: string; source: ConnectionSource } | null = null;
  project: { id: number; name: string } | null = null;
  /** The branch the indexes describe; null for the default branch. */
  branch: string | null = null;
  index: LocatorIndex | null = null;
  codeIndex: CodeIndex | null = null;
  /** Why the context has no data, in one sentence; null when it has. */
  problem: string | null = null;
  /** What `problem` is about; null with no problem. */
  problemKind: ProblemKind | null = null;
  /** The version of `@piwitests/reporter` the project installs, read at each refresh; null when none is found. */
  reporterVersion: string | null = null;
  /**
   * The branch whose latest run is read. On the ladder: the checked-out one, else, while it has no run, the project's
   * default branch, else null for the newest run of any branch. Otherwise the chosen branch, the chosen run's, or for a
   * developer's own runs the checked-out one.
   */
  runBranch: string | null = null;
  /** The branch checked out in the workspace; null on a detached head. */
  checkedOutBranch: string | null = null;
  /** The run the workspace is compared with, chosen in the editor (`piwi/setBaseline`); the ladder until then. */
  baseline: BaselineChoice = { kind: 'ladder' };
  /** What `baseline` found at the latest read, in a few words (`baselineLabel`); empty before the first. */
  baselineLabel = '';
  /** The branches a baseline can be chosen from: the default branch, then those with runs the locator index knows. */
  branches: string[] = [];
  /** Quarantined tests by test case id, and the passing streak that releases one. */
  quarantined = new Map<number, QuarantinedTest>();
  releaseAfter = 0;
  /** The project's selections and the tests each selects, resolved at each refresh. */
  selections: Array<{ key: string; name: string; tests: Set<number>; command: string }> = [];
  /** Tests whose timeout could be tighter, by test case id. */
  timeouts = new Map<number, TimeoutAdvice>();
  /** The project's flaky tests on the branch the indexes describe, by test case id. */
  flaky = new Map<number, FlakyTest>();
  /** The project's Flake Lab tests on that branch, with their top suspect, by test case id. */
  flakeLab = new Map<number, FlakeLabEntry>();
  /** The baseline on `runBranch` and its failures; null before the first answer. */
  failures: BranchFailures | null = null;
  /** When `failures` was last read (ms since the epoch); null before the first answer. */
  runReadAt: number | null = null;
  /** The run in progress the context follows: the editor's own, else one on its branch; null while none runs. */
  live: LiveRun | null = null;
  /**
   * The tests of `live` that began or ended, by test case id, until the latest run is read once it ended: what the
   * gutter shows over the latest run's results meanwhile.
   */
  liveTests = new Map<number, LiveTestStatus>();
  /** The runs the editor started on this instance (`piwi/runArgs`, `piwi/runSelection`), for the service's life. */
  readonly ownRuns = new Set<number>();
  /**
   * The text of each file a failure goes through as saved when the service first placed the failure, by execution and
   * file: where its lines are followed from when its run's commit does not give the file (a run on a developer's
   * machine, a commit the repository lacks). Kept while the latest run stays the same and the failure is listed.
   */
  readonly failureAnchors = new Map<number, Map<string, string>>();
  /** Whether the instance serves coverage: false once it answered the route with a 404, until the next refresh. */
  coverageRoute = true;
  /** Each file's coverage, by the branch read and the file's repository-relative path, the latest asked last. */
  private readonly coverages = new Map<string, CoverageEntry>();
  private functions: { at: number; items: TestFunctionEntry[] } | null = null;
  private words: { at: number; value: { tags: string[]; features: string[] } } | null = null;
  private readonly issues = new Map<number, Promise<EntityLink[]>>();
  private readonly fixPlans = new Map<number, Promise<FixPlan | null>>();
  private readonly fixPlanTexts = new Map<number, Promise<string | null>>();
  private readonly healings = new Map<number, Promise<LocatorHealingResult | null>>();
  private readonly downloads = new Map<string, Promise<string | null>>();
  private readonly catalog = new Map<string, { at: number; items: CatalogCase[] }>();
  private readonly alternatives = new Map<string, { at: number; items: CallSiteAlternatives[] }>();
  private committedFiles = new Map<string, string | null>();
  private readonly commitTexts = new Map<string, CommitText>();
  /** The translation values of `HEAD` and of the working tree, by the `HEAD` they were read at. */
  private translations: {
    head: string | null;
    old?: Promise<Map<string, string>>;
    new?: Promise<Map<string, string>>;
  } = {
    head: null,
  };
  private head: string | null = null;

  constructor(
    /** The Playwright config's directory: call sites resolve against it. */
    readonly root: string,
    /**
     * The answers of the instance's conditional requests, shared by the contexts of one service: a 304 hands back the
     * same object, and the configs reading one project share it.
     */
    private readonly answers: ResponseCache = new Map(),
  ) {
    this.repoRoot = root;
  }

  /**
   * Resolve the connection and project, read the latest run (then `onRun` is called, so its failures show before the
   * rest arrives), then fetch the other indexes side by side. Never throws: a failure is kept in `problem`, and cached
   * data stays.
   */
  async refresh(env: Record<string, string | undefined>, editor: EditorCredentials, onRun?: () => void): Promise<void> {
    this.repoRoot = await repositoryRoot(this.root);
    this.reporterVersion = reporterVersion(this.root, this.repoRoot);
    const head = await headCommit(this.repoRoot);
    if (head !== this.head) {
      this.head = head;
      this.committedFiles = new Map();
    }
    // The working tree's translations are read again; those of `HEAD` stay while it does.
    this.translations = { head: this.translations.head, old: this.translations.old };
    const named = namedInstance(this.root, this.repoRoot, env, editor);
    this.instance = named && { serverUrl: named.serverUrl, source: named.source };
    const connection = resolveContextConnection(this.root, this.repoRoot, env, editor);
    // What was read from another instance is not this one's: its ids name other things.
    if (connection?.serverUrl !== this.client?.connection.serverUrl) this.forget();
    if (!connection) {
      this.client = null;
      this.source = null;
      this.fail(
        'not-configured',
        'No Piwi instance configured: set PIWI_DASHBOARD_URL, run piwi init, or run Piwi: Connect.',
      );
      return;
    }
    this.client = new PiwiClient(connection, this.answers);
    this.source = connection.source;
    this.coverageRoute = true;
    try {
      if (!connection.project) {
        this.fail(
          'no-project',
          connection.source === 'desktop'
            ? "No project linked to this folder in the Piwi desktop app: link it on the project's page there, or run Piwi: Connect."
            : 'No project chosen: set PIWI_PROJECT_NAME or run Piwi: Connect.',
        );
        return;
      }
      if (!this.project || this.project.name !== connection.project) {
        this.project = await this.client.resolveProject(connection.project);
        if (!this.project) {
          this.fail('no-project', `No project named "${connection.project}" on ${connection.serverUrl}.`);
          return;
        }
      }
      const index = await this.client.locatorIndex(this.project.id, null);
      this.branches = [
        ...new Set([index.defaultBranch, ...index.branches.map((b) => b.name)].filter((b): b is string => !!b)),
      ];
      // The checked-out branch when the index has uses of its own for it, else the default branch.
      const checkedOut = await currentBranch(this.repoRoot);
      this.branch =
        checkedOut && checkedOut !== index.defaultBranch && index.branches.some((b) => b.name === checkedOut)
          ? checkedOut
          : null;
      this.index = this.branch ? await this.client.locatorIndex(this.project.id, this.branch) : index;
      // The failures first: what the other indexes add to them comes once they answer.
      this.problem = null;
      this.problemKind = null;
      await this.refreshRun();
      onRun?.();
      const client = this.client;
      const projectId = this.project.id;
      this.catalog.clear();
      this.alternatives.clear();
      this.functions = null;
      this.words = null;
      await Promise.all([
        client
          .codeIndex(projectId, this.branch)
          .catch(() => null)
          .then((codeIndex) => (this.codeIndex = codeIndex)),
        client
          .flakyTests(projectId, this.branch)
          .then((flaky) => (this.flaky = new Map(flaky.map((f) => [f.testCaseId, f]))))
          .catch(() => {}),
        client
          .flakeLab(projectId, this.branch)
          .then((flakeLab) => (this.flakeLab = new Map(flakeLab.map((t) => [t.testCaseId, t]))))
          .catch(() => {}),
        client
          .quarantine(projectId)
          .then((quarantine) => {
            this.quarantined = new Map(quarantine.entries.map((q) => [q.testCaseId, q]));
            this.releaseAfter = quarantine.releaseAfter;
          })
          .catch(() => {}),
        client
          .resolvedSelections(projectId, MAX_SELECTIONS)
          .then(
            (selections) =>
              (this.selections = selections.map((s) => ({
                key: s.key,
                name: s.name,
                tests: new Set(s.testCaseIds),
                command: s.command,
              }))),
          )
          .catch(() => {}),
        client
          .timeoutOpportunities(projectId)
          .then((timeouts) => (this.timeouts = new Map(timeouts.map((t) => [t.testCaseId, t]))))
          .catch(() => {}),
        // Completion reads these: fetched here, so no keystroke waits on them.
        this.functionCatalog(),
        this.vocabulary(),
      ]);
    } catch (e) {
      const refused = e instanceof PiwiHttpError && (e.status === 401 || e.status === 403);
      if (refused) {
        this.fail(
          'refused',
          connection.apiKey
            ? `${connection.serverUrl} refused the API key (${e.status}): run Piwi: Connect to sign in again.`
            : `${connection.serverUrl} needs an API key (${e.status}): run Piwi: Connect to sign in.`,
        );
      } else {
        this.fail('unreachable', `Could not reach ${connection.serverUrl}: ${(e as Error).message}`);
      }
    }
  }

  private fail(kind: ProblemKind, problem: string): void {
    this.problemKind = kind;
    this.problem = problem;
  }

  /**
   * Drop everything read from the instance: the project, its indexes, the latest run, the runs followed and the
   * per-file answers.
   */
  private forget(): void {
    this.project = null;
    this.branch = null;
    this.index = null;
    this.codeIndex = null;
    this.quarantined = new Map();
    this.releaseAfter = 0;
    this.selections = [];
    this.timeouts = new Map();
    this.flaky = new Map();
    this.flakeLab = new Map();
    this.failures = null;
    this.runReadAt = null;
    this.live = null;
    this.liveTests = new Map();
    this.ownRuns.clear();
    this.failureAnchors.clear();
    this.commitTexts.clear();
    this.runBranch = null;
    this.checkedOutBranch = null;
    this.baselineLabel = '';
    this.branches = [];
    this.functions = null;
    this.words = null;
    this.coverages.clear();
    for (const cache of [
      this.issues,
      this.fixPlans,
      this.fixPlanTexts,
      this.healings,
      this.catalog,
      this.alternatives,
    ]) {
      cache.clear();
    }
  }

  /**
   * Fetch the baseline the editor chose and the runs laid over it. The ladder reads the latest run on the checked-out
   * branch (the default branch on a detached head); while that branch has no run, the default branch's, else the
   * newest of any branch. A branch, a run or a developer's own runs are read once: when they hold no run, nothing else
   * is read. Returns whether the run, its failures or the baseline changed.
   */
  async refreshRun(): Promise<boolean> {
    if (!this.client || !this.project) return false;
    const client = this.client;
    const projectId = this.project.id;
    const checkedOut = await currentBranch(this.repoRoot);
    const defaultBranch = this.index?.defaultBranch ?? null;
    const choice = this.baseline;
    try {
      let branch: string | null;
      let next: BranchFailures;
      if (choice.kind === 'branch') {
        branch = choice.branch;
        next = await client.branchFailures(projectId, branch);
      } else if (choice.kind === 'run') {
        next = await client.branchFailures(projectId, null, { run: choice.runId }).catch((e: unknown) => {
          // A run the instance does not hold, or another project's.
          if (e instanceof PiwiHttpError && (e.status === 400 || e.status === 404)) return noRun();
          throw e;
        });
        // An instance that does not read `run` answers another run.
        if (next.run && next.run.id !== choice.runId) next = noRun();
        branch = next.run?.branch ?? null;
      } else if (choice.kind === 'local') {
        branch = checkedOut ?? defaultBranch;
        next = await client.branchFailures(projectId, branch, { origin: 'local' });
        // An instance that does not read `origin` answers a CI run.
        if (next.run && !LOCAL_ORIGINS.has(next.run.origin ?? '')) next = noRun();
      } else {
        // A branch that never ran shows the run it grew from: the default branch's, else the newest of any branch.
        const ladder = [...new Set([checkedOut ?? defaultBranch, defaultBranch, null])];
        branch = ladder[0] ?? null;
        next = await client.branchFailures(projectId, branch);
        for (const other of ladder.slice(1)) {
          if (next.run) break;
          branch = other;
          next = await client.branchFailures(projectId, other);
        }
      }
      const label = baselineLabel(choice, next, branch);
      const changed =
        branch !== this.runBranch ||
        checkedOut !== this.checkedOutBranch ||
        label !== this.baselineLabel ||
        JSON.stringify(next) !== JSON.stringify(this.failures);
      if (next.run?.id !== this.failures?.run?.id) {
        this.healings.clear();
        this.issues.clear();
        this.fixPlans.clear();
        this.fixPlanTexts.clear();
        this.failureAnchors.clear();
        this.commitTexts.clear();
      } else {
        // The files of the commits no run listed was made at any more.
        const commits = new Set([next.run?.commit, ...(next.overlays ?? []).map((o) => o.commit)]);
        for (const [key, entry] of this.commitTexts) if (!commits.has(entry.commit)) this.commitTexts.delete(key);
      }
      const listed = new Set([...next.failures, ...(next.resolved ?? [])].map((f) => f.executionId));
      for (const id of this.failureAnchors.keys()) if (!listed.has(id)) this.failureAnchors.delete(id);
      this.runBranch = branch;
      this.checkedOutBranch = checkedOut;
      this.baselineLabel = label;
      this.failures = next;
      this.runReadAt = Date.now();
      return changed;
    } catch {
      return false;
    }
  }

  /**
   * Read the code index again, with its `ETag`: a run that ended may have recorded the coverage of files it did not
   * list. Keeps what it held when the read fails.
   */
  async refreshCodeIndex(): Promise<void> {
    const client = this.client;
    const project = this.project;
    if (!client || !project) return;
    const codeIndex = await client.codeIndex(project.id, this.branch).catch(() => null);
    if (codeIndex && this.client === client) this.codeIndex = codeIndex;
  }

  /** The branch whose coverage is read: the checked-out one, which the instance completes with the default branch's. */
  coverageBranch(): string | null {
    return this.checkedOutBranch ?? this.branch;
  }

  /**
   * A file's coverage (repository-relative): read when first asked, then kept and asked again with its `ETag` once
   * stale (`staleCoverage`), the read on its way shared by the asks meanwhile. Null when there is none, or the instance
   * has no coverage route. A read that fails without the instance refusing it keeps what was read before, and is asked
   * again next time.
   */
  coverage(repoRelative: string): Promise<FileCoverage | null> {
    const key = `${this.coverageBranch() ?? ''}\n${repoRelative}`;
    const entry: CoverageEntry = this.coverages.get(key) ?? {
      value: null,
      etag: null,
      read: null,
      stale: true,
      again: false,
    };
    this.coverages.delete(key);
    this.coverages.set(key, entry);
    for (const oldest of [...this.coverages.keys()].slice(0, Math.max(0, this.coverages.size - MAX_COVERAGES)))
      this.coverages.delete(oldest);
    if (entry.read) return entry.read;
    if (!entry.stale) return Promise.resolve(entry.value);
    const branch = this.coverageBranch();
    entry.read = (async () => {
      do {
        entry.again = false;
        entry.stale = false;
        await this.readCoverage(entry, repoRelative, branch);
      } while (entry.again);
      return entry.value;
    })().finally(() => {
      entry.read = null;
    });
    return entry.read;
  }

  /**
   * Mark every file's coverage to be read again on its next ask, and once more after a read on its way: a refresh, or a
   * run that ended, may have recorded new coverage.
   */
  staleCoverage(): void {
    for (const entry of this.coverages.values()) {
      entry.stale = true;
      if (entry.read) entry.again = true;
    }
  }

  private async readCoverage(entry: CoverageEntry, repoRelative: string, branch: string | null): Promise<void> {
    const client = this.client;
    const project = this.project;
    if (!client || !project || !this.coverageRoute) return;
    const known = entry.etag && entry.value ? { etag: entry.etag, value: entry.value } : null;
    try {
      const answer = await client.fileCoverage(project.id, repoRelative, branch, known);
      // Read from an instance the context no longer reads: its ids name other things.
      if (this.client !== client) return;
      entry.value = answer.value;
      entry.etag = answer.etag;
    } catch (e) {
      const status = e instanceof PiwiHttpError ? e.status : 0;
      if (this.client !== client) return;
      if (status === 404) this.coverageRoute = false;
      if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
        entry.value = null;
        entry.etag = null;
      } else {
        entry.stale = true;
      }
    }
  }

  /** The project's function catalog, reused for five minutes. */
  async functionCatalog(): Promise<TestFunctionEntry[]> {
    if (!this.client || !this.project) return [];
    if (this.functions && Date.now() - this.functions.at < FILE_CACHE_MS) return this.functions.items;
    const items = await this.client.testFunctions(this.project.id).catch(() => this.functions?.items ?? []);
    this.functions = { at: Date.now(), items };
    return items;
  }

  /** The tickets linked to a failure's cluster or test, fetched once per run. */
  issuesOf(failure: BranchFailure): Promise<EntityLink[]> {
    const client = this.client;
    if (!client) return Promise.resolve([]);
    return once(
      this.issues,
      failure.executionId,
      () =>
        Promise.all([
          failure.clusterId ? client.links('failure_cluster', failure.clusterId) : [],
          client.links('test_case', failure.testCaseId),
        ]).then(([cluster, test]) => [...new Map([...cluster, ...test].map((l) => [l.url, l])).values()]),
      [],
    );
  }

  /** A failure cluster's fix plan, fetched once per run. */
  fixPlan(clusterId: number): Promise<FixPlan | null> {
    const client = this.client;
    return client ? once(this.fixPlans, clusterId, () => client.fixPlan(clusterId), null) : Promise.resolve(null);
  }

  /** The same plan as Markdown, fetched once per run. */
  fixPlanText(clusterId: number): Promise<string | null> {
    const client = this.client;
    return client
      ? once(this.fixPlanTexts, clusterId, () => client.fixPlanMarkdown(clusterId), null)
      : Promise.resolve(null);
  }

  /** Tags and features (reused for five minutes) and the workspace's CODEOWNERS owners, for annotation completion. */
  async vocabulary(): Promise<{ tags: string[]; features: string[]; owners: string[] }> {
    if (!this.words || Date.now() - this.words.at >= FILE_CACHE_MS) {
      const value =
        this.client && this.project
          ? await this.client.vocabulary(this.project.id).catch(() => ({ tags: [], features: [] }))
          : { tags: [], features: [] };
      this.words = { at: Date.now(), value };
    }
    return { ...this.words.value, owners: codeOwners(this.repoRoot) };
  }

  /** The healing of a failed execution, fetched once. */
  healing(executionId: number): Promise<LocatorHealingResult | null> {
    const client = this.client;
    return client
      ? once(this.healings, executionId, () => client.locatorHealing(executionId), null)
      : Promise.resolve(null);
  }

  /** A stored file downloaded to the temporary directory, once; null when it cannot be fetched. */
  evidence(storedPath: string): Promise<string | null> {
    const client = this.client;
    if (!client) return Promise.resolve(null);
    const key = `${client.connection.serverUrl}\n${storedPath}`;
    let found = this.downloads.get(key);
    if (!found) {
      const dir = path.join(EVIDENCE_ROOT, createHash('sha256').update(key).digest('hex').slice(0, 16));
      // The name comes from the server and ends up in a `show-trace "<path>"` command: keep it to plain characters.
      const name = path.basename(storedPath).replace(/[^\w.-]/g, '_');
      const target = path.join(dir, name && name !== '.' && name !== '..' ? name : 'file');
      found = (async () => {
        try {
          if (fs.existsSync(target)) {
            // Used again: kept by `pruneEvidence` as long as a fresh download.
            const now = new Date();
            await fs.promises.utimes(dir, now, now);
            return target;
          }
          await fs.promises.mkdir(dir, { recursive: true });
          await client.download(storedPath, target);
          return target;
        } catch {
          this.downloads.delete(key);
          return null;
        }
      })();
      this.downloads.set(key, found);
    }
    return found;
  }

  /** The catalog's cases defined in a spec file (its path relative to the config). */
  async casesOf(relativeFile: string): Promise<CatalogCase[]> {
    if (!this.client || !this.project) return [];
    const cached = this.catalog.get(relativeFile);
    if (cached && Date.now() - cached.at < FILE_CACHE_MS) return cached.items;
    try {
      const items = await this.client.testCases(this.project.id, relativeFile);
      this.catalog.set(relativeFile, { at: Date.now(), items });
      return items;
    } catch {
      return cached?.items ?? [];
    }
  }

  /** The stored alternatives of a file's call sites. */
  async alternativesOf(relativeFile: string): Promise<CallSiteAlternatives[]> {
    if (!this.client || !this.project) return [];
    const cached = this.alternatives.get(relativeFile);
    if (cached && Date.now() - cached.at < FILE_CACHE_MS) return cached.items;
    try {
      const items = await this.client.locatorAlternatives(this.project.id, relativeFile);
      this.alternatives.set(relativeFile, { at: Date.now(), items });
      return items;
    } catch {
      return cached?.items ?? [];
    }
  }

  /**
   * A file (repository-relative) as `commit` holds it: null when the local repository lacks the commit or the path,
   * undefined until read. The first call starts the read, which `read` settles with: each file is read once per commit,
   * kept while the latest run stays the same and a run listed with it was made at that commit, as many files as the
   * failures go through.
   */
  textAtCommit(commit: string, repoRelative: string): CommitText {
    const key = `${commit}\n${repoRelative}`;
    const known = this.commitTexts.get(key);
    if (known) return known;
    const read = committedTextAt(this.repoRoot, commit, repoRelative);
    const entry: CommitText = { commit, text: undefined, read };
    void read.then((text) => {
      entry.text = text;
    });
    this.commitTexts.set(key, entry);
    return entry;
  }

  /** A file as `HEAD` holds it (repository-relative), cached until `HEAD` moves. */
  async committed(repoRelative: string): Promise<string | null> {
    if (!this.committedFiles.has(repoRelative)) {
      this.committedFiles.set(repoRelative, await committedText(this.repoRoot, repoRelative));
    }
    return this.committedFiles.get(repoRelative) ?? null;
  }

  /**
   * Translation values of `HEAD` (`old`), read again once `HEAD` moves, and of the working tree (`new`), read again on
   * each refresh: each read once for every document that asks meanwhile, and again after it failed.
   */
  async translationMaps(): Promise<{ old: Map<string, string>; new: Map<string, string> }> {
    if (this.translations.head !== this.head) this.translations = { head: this.head };
    const read = (side: 'old' | 'new'): Promise<Map<string, string>> => {
      const known = this.translations[side];
      if (known) return known;
      const values = translationValues(this.repoRoot, side);
      this.translations[side] = values;
      values.catch(() => {
        if (this.translations[side] === values) this.translations[side] = undefined;
      });
      return values;
    };
    const [old, current] = await Promise.all([read('old'), read('new')]);
    return { old, new: current };
  }
}
