/**
 * The Testing view's Piwi tests (`piwi.testExplorer`): the specs the catalog knows, as they stand, each test with its
 * latest result as the service reads it (`piwi/testItems`), published as a test run whenever the latest run changes;
 * a run in progress followed as a test run of its own; and two run profiles, **Run with Piwi** and **Verify ×3 with
 * Piwi**, that run tests as every other run of the extension does, through the command the service builds.
 */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  TEST_ITEMS_REQUEST,
  type LiveRun,
  type LiveTestStatus,
  type RunCommand,
  type RunStatusResult,
  type RunTestsArgs,
  type TestItemsParams,
  type TestItemsResult,
} from '@piwitests/editor/protocol';
import {
  SPEC_FILE,
  VERIFY_REPEAT,
  liveRunName,
  resultsKey,
  resultsRunName,
  testOutcome,
  testRunsOf,
  testTree,
  unfollowedOutcome,
  withSpec,
  type TestNode,
  type TestOutcome,
  type TreeTest,
} from './glue';

/** How long after a run's command ended the test run that started it waits for Piwi to follow the run. */
const RUN_FOLLOW_WAIT_MS = 15_000;
/** Pause after an edit of a spec before its tests are read again. */
const SPEC_EDIT_MS = 300;
/** The type of a test run's task (`taskDefinitions` in `package.json`), told apart by its ref. */
const RUN_TASK_TYPE = 'piwi';

/** A command a run profile started: its config, its ref, and how far it got. */
interface ProfilePart {
  root: string;
  /** The ref of its command, once the command started. */
  ref: string | null;
  /** The run in progress Piwi follows for it, once it started. */
  liveRunId: number | null;
  /** Its exit code once its task ended; undefined until then. */
  exitCode: number | null | undefined;
  /** Whether the run it started was read once it ended, or no run was followed for it in time. */
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A run of a run profile: its test run, until each of its commands ended and its run was read. */
interface ProfileRun {
  run: vscode.TestRun;
  /** The tests it runs, and the result each was last shown with. */
  tests: Map<vscode.TestItem, TreeTest>;
  shown: Set<vscode.TestItem>;
  parts: ProfilePart[];
  /** While its commands are being started: it does not end before the last one started. */
  starting: boolean;
}

/** The run in progress of a Playwright config, as its own test run, or as the one of the profile that started it. */
interface Followed {
  runId: number;
  run: vscode.TestRun;
  profile: ProfileRun | null;
  /** The last result of each test the run began or ended, by its id. */
  results: Map<number, LiveTestStatus>;
  /** The state each item was last shown in. */
  shown: Map<vscode.TestItem, string>;
}

/** A result the Testing view shows: a test's outcome, or an error a run gave a test it has no result of. */
type Shown = TestOutcome | { state: 'errored'; message: string };

/** What the integration suite reads of the Testing view: each test, where it is, and the result last shown for it. */
export interface ShownTest {
  label: string;
  uri: string;
  line: number | null;
  result: Shown | null;
}

export class TestExplorer implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController('piwi', 'Piwi');
  private readonly disposables: vscode.Disposable[] = [];
  /** The service's last answer, which a spec's own answer replaces in place. */
  private answer: TestItemsResult = { contexts: [] };
  /** Each test's item and what the service says of it, and the items of each test the catalog knows, by its id. */
  private readonly testOf = new Map<vscode.TestItem, TreeTest>();
  private byCase = new Map<number, vscode.TestItem[]>();
  /** The result each test was last shown with. */
  private readonly results = new Map<string, Shown>();
  private runs: RunStatusResult | null = null;
  /** What the published results stand for (`resultsKey`); null before the first. */
  private published: string | null = null;
  private readonly profiles = new Set<ProfileRun>();
  /** The exit codes of commands that ended while a profile run was starting them, by ref, until it takes them. */
  private readonly endedEarly = new Map<string, number | null>();
  private readonly followed = new Map<string, Followed>();
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private readonly edits = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly lc: LanguageClient,
    private readonly runTests: (args: RunTestsArgs) => Promise<RunCommand | null>,
  ) {
    this.controller.refreshHandler = () => this.read().then(() => this.publish());
    this.controller.createRunProfile('Run with Piwi', vscode.TestRunProfileKind.Run, (request, token) =>
      this.runProfile(request, token),
    );
    this.controller.createRunProfile(
      `Verify ×${VERIFY_REPEAT} with Piwi`,
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runProfile(request, token, VERIFY_REPEAT),
      false,
    );
    this.disposables.push(
      this.controller,
      // A spec's tests follow its edits, 300 ms after the last; a spec opened that the tree lacks joins it.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.contentChanges.length || !isSpec(e.document)) return;
        const uri = e.document.uri.toString();
        clearTimeout(this.edits.get(uri));
        this.edits.set(
          uri,
          setTimeout(() => {
            this.edits.delete(uri);
            void this.readSpec(uri);
          }, SPEC_EDIT_MS),
        );
      }),
      vscode.workspace.onDidOpenTextDocument((d) => {
        if (isSpec(d) && !this.holds(d.uri.toString())) void this.readSpec(d.uri.toString());
      }),
      { dispose: () => this.edits.forEach((t) => clearTimeout(t)) },
    );
  }

  /**
   * The runs the status bar shows changed. A run in progress is followed as a test run, which shows its results as it
   * goes and once it was read; any other change publishes the latest results again. `full` reads the tests again
   * whatever changed: the connection did.
   */
  runsChanged(runs: RunStatusResult | null, full = false): void {
    this.runs = runs;
    const ended: Followed[] = [];
    const roots = new Set((runs?.contexts ?? []).map((c) => c.root));
    for (const [root, followed] of this.followed) {
      if (!roots.has(root)) {
        this.followed.delete(root);
        ended.push(followed);
      }
    }
    for (const c of runs?.contexts ?? []) {
      let followed = this.followed.get(c.root);
      if (followed && followed.runId !== c.live?.runId) {
        this.followed.delete(c.root);
        ended.push(followed);
        followed = undefined;
      }
      if (!c.live) continue;
      followed ??= this.follow(c.root, c.live);
      for (const t of c.liveTests ?? []) followed.results.set(t.testCaseId, t.status);
      this.progress(followed);
    }
    if (!ended.length && !full && resultsKey(runs) === this.published) return;
    void this.read().then(() => {
      for (const followed of ended) this.settle(followed);
      // The results the runs followed brought are shown in their test runs: the published ones stand for them too.
      if (ended.length && !full) this.published = resultsKey(this.runs);
      else this.publish();
    });
  }

  /** A test run's task ended, with its exit code: the profile run that started it settles once its run is read. */
  taskEnded(ref: string, exitCode: number | null): void {
    const known = [...this.profiles].some((profile) => profile.parts.some((p) => p.ref === ref));
    // A command that ended before its profile run heard its ref: the profile run takes the end with the ref.
    if (!known && [...this.profiles].some((profile) => profile.starting)) this.endedEarly.set(ref, exitCode);
    for (const profile of this.profiles) {
      const part = profile.parts.find((p) => p.ref === ref);
      if (!part || part.exitCode !== undefined) continue;
      part.exitCode = exitCode;
      if (part.settled) this.finishProfile(profile);
      else if (part.liveRunId === null) {
        // A run that never reached the instance, or one the stream did not announce: settled by its exit code.
        part.timer = setTimeout(() => {
          part.timer = null;
          if (part.liveRunId !== null) return;
          part.settled = true;
          this.finishProfile(profile);
        }, RUN_FOLLOW_WAIT_MS);
      }
    }
  }

  /** The tests the Testing view lists, with the result last shown for each. */
  shown(): ShownTest[] {
    return [...this.testOf].map(([item, test]) => ({
      label: item.label,
      uri: test.uri,
      line: item.range?.start.line ?? null,
      result: this.results.get(item.id) ?? null,
    }));
  }

  dispose(): void {
    this.disposed = true;
    for (const followed of this.followed.values()) if (!followed.profile) followed.run.end();
    for (const profile of this.profiles) {
      for (const part of profile.parts) if (part.timer) clearTimeout(part.timer);
      profile.run.end();
    }
    this.followed.clear();
    this.profiles.clear();
    for (const d of this.disposables) d.dispose();
  }

  /** Read every test again: the catalog's specs and the open ones. One read at a time; those asked meanwhile join one. */
  private read(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.chain
      .then(async () => {
        this.queued = null;
        const uris = vscode.workspace.textDocuments.filter(isSpec).map((d) => d.uri.toString());
        const answer = await this.ask({ uris });
        if (answer) this.draw(answer);
      })
      .catch(drawFailed);
    this.queued = next;
    this.chain = next;
    return next;
  }

  /** Read one spec's tests again, as it stands, in turn with the other reads. */
  private readSpec(uri: string): Promise<void> {
    const next = this.chain
      .then(async () => {
        const answer = await this.ask({ uris: [uri], catalog: false });
        if (answer) this.draw(withSpec(this.answer, uri, answer));
      })
      .catch(drawFailed);
    this.chain = next;
    return next;
  }

  private ask(params: TestItemsParams): Promise<TestItemsResult | null> {
    if (this.disposed) return Promise.resolve(null);
    return this.lc.sendRequest<TestItemsResult>(TEST_ITEMS_REQUEST, params).then(asEditorUris, () => null);
  }

  /** Whether the tree holds a spec. */
  private holds(uri: string): boolean {
    return this.answer.contexts.some((c) => c.specs.some((s) => s.uri === uri));
  }

  /** Make the tree the answer's, keeping the items that stay, with their results. */
  private draw(answer: TestItemsResult): void {
    if (this.disposed) return;
    this.answer = answer;
    this.testOf.clear();
    this.byCase = new Map();
    this.sync(this.controller.items, testTree(answer));
  }

  private sync(collection: vscode.TestItemCollection, nodes: readonly TestNode[]): void {
    const items = nodes.map((node) => {
      const uri = node.uri ? vscode.Uri.parse(node.uri) : undefined;
      let item = collection.get(node.id);
      if (!item || item.uri?.toString() !== uri?.toString())
        item = this.controller.createTestItem(node.id, node.label, uri);
      item.label = node.label;
      item.sortText = node.sortText;
      // To the end of the call's last line, so the cursor anywhere in the test is in it.
      item.range = node.range ? new vscode.Range(node.range.start, 0, node.range.end, 10_000) : undefined;
      if (node.test) {
        this.testOf.set(item, node.test);
        if (node.test.testCaseId !== null) {
          this.byCase.set(node.test.testCaseId, [...(this.byCase.get(node.test.testCaseId) ?? []), item]);
        }
      }
      this.sync(item.children, node.children);
      return item;
    });
    collection.replace(items);
  }

  /** Publish each test's latest result as one test run, named after the run it comes from. */
  private publish(): void {
    if (this.disposed) return;
    this.published = resultsKey(this.runs);
    const run = this.controller.createTestRun(new vscode.TestRunRequest(), resultsRunName(this.runs), false);
    for (const [item, test] of this.testOf) {
      const outcome = testOutcome(test.status, test.failure);
      // A test the run in progress runs shows in that run's own test run.
      if (outcome && outcome.state !== 'started') this.show(run, item, outcome);
    }
    run.end();
  }

  private show(run: vscode.TestRun, item: vscode.TestItem, outcome: TestOutcome): void {
    this.results.set(item.id, outcome);
    switch (outcome.state) {
      case 'passed':
        return run.passed(item);
      case 'skipped':
        return run.skipped(item);
      case 'started':
        return run.started(item);
      case 'failed': {
        const message = new vscode.TestMessage(outcome.message);
        if (item.uri && outcome.line !== null) {
          message.location = new vscode.Location(item.uri, new vscode.Position(outcome.line, 0));
        }
        return run.failed(item, message);
      }
    }
  }

  /**
   * Follow a config's run in progress: in the test run of the profile run that started it, when it is the editor's
   * own and one of a profile run's commands waits for its run there; else in a test run of its own.
   */
  private follow(root: string, live: LiveRun): Followed {
    let profile: ProfileRun | null = null;
    if (live.own) {
      for (const p of this.profiles) {
        const part = p.parts.find((x) => x.root === root && x.liveRunId === null && !x.settled);
        if (!part) continue;
        part.liveRunId = live.runId;
        if (part.timer) clearTimeout(part.timer);
        part.timer = null;
        profile = p;
        break;
      }
    }
    const run = profile?.run ?? this.controller.createTestRun(new vscode.TestRunRequest(), liveRunName(live), false);
    const followed: Followed = { runId: live.runId, run, profile, results: new Map(), shown: new Map() };
    this.followed.set(root, followed);
    return followed;
  }

  /** Show the results a run in progress brought since the last time. */
  private progress(followed: Followed): void {
    for (const [id, status] of followed.results) {
      for (const item of this.byCase.get(id) ?? []) {
        if (followed.profile && !followed.profile.tests.has(item)) continue;
        if (followed.shown.get(item) === status) continue;
        followed.shown.set(item, status);
        const outcome =
          status === 'failed'
            ? { state: 'failed' as const, message: `Failed in run #${followed.runId}.`, line: null }
            : testOutcome(status, null);
        if (outcome) this.show(followed.run, item, outcome);
      }
    }
  }

  /**
   * A run followed ended and the tests were read again: each test it ran shows its result in that run, a failure with
   * why and where from the latest run, and its test run ends, or, for a profile run's, settles that command.
   */
  private settle(followed: Followed): void {
    for (const [id, status] of followed.results) {
      for (const item of this.byCase.get(id) ?? []) {
        if (followed.profile && !followed.profile.tests.has(item)) continue;
        const test = this.testOf.get(item);
        const read = status === 'failed' && test?.status === 'failed' ? test.failure : null;
        // A test still running when the run ended has no result of it.
        const outcome = status === 'running' ? null : testOutcome(status, read);
        if (!outcome) continue;
        this.show(followed.run, item, outcome);
        followed.profile?.shown.add(item);
      }
    }
    if (!followed.profile) {
      followed.run.end();
      return;
    }
    for (const part of followed.profile.parts) if (part.liveRunId === followed.runId) part.settled = true;
    this.finishProfile(followed.profile);
  }

  /** End a profile run once each of its commands ended and settled, with a result for every test (`unfollowedOutcome`). */
  private finishProfile(profile: ProfileRun): void {
    if (!this.profiles.has(profile) || profile.starting) return;
    if (!profile.parts.every((p) => p.settled && p.exitCode !== undefined)) return;
    this.profiles.delete(profile);
    const outcome = unfollowedOutcome(profile.parts.map((p) => p.exitCode ?? null));
    for (const item of profile.tests.keys()) {
      if (profile.shown.has(item)) continue;
      if (outcome.state === 'passed') this.show(profile.run, item, outcome);
      else {
        this.results.set(item.id, outcome);
        profile.run.errored(item, new vscode.TestMessage(outcome.message));
      }
    }
    profile.run.end();
  }

  /**
   * Run the tests a request names, one command per Playwright config, as every test run of the extension (the
   * breakpoints included): its test run shows them queued, then the run Piwi follows for each command.
   */
  private async runProfile(request: vscode.TestRunRequest, token: vscode.CancellationToken, repeat?: number) {
    const excluded = new Set(request.exclude ?? []);
    const picked = new Map<vscode.TestItem, TreeTest>();
    const visit = (item: vscode.TestItem) => {
      if (excluded.has(item)) return;
      const test = this.testOf.get(item);
      if (test) picked.set(item, test);
      else item.children.forEach(visit);
    };
    if (request.include) request.include.forEach(visit);
    else this.controller.items.forEach(visit);
    const run = this.controller.createTestRun(request, repeat ? `Piwi: verify ×${repeat}` : 'Piwi', false);
    if (!picked.size) {
      run.end();
      return;
    }
    for (const item of picked.keys()) run.enqueued(item);
    const profile: ProfileRun = { run, tests: picked, shown: new Set(), parts: [], starting: true };
    // Followed from the start: a command's run, or its end, may come while the next command starts.
    this.profiles.add(profile);
    for (const args of testRunsOf([...picked.values()], repeat)) {
      const part: ProfilePart = {
        root: args.root!,
        ref: null,
        liveRunId: null,
        exitCode: undefined,
        settled: false,
        timer: null,
      };
      profile.parts.push(part);
      const command = await this.runTests(args).catch(() => null);
      if (command?.ref) {
        part.ref = command.ref;
        if (this.endedEarly.has(command.ref)) {
          const exitCode = this.endedEarly.get(command.ref)!;
          this.endedEarly.delete(command.ref);
          this.taskEnded(command.ref, exitCode);
        }
        continue;
      }
      profile.parts.splice(profile.parts.indexOf(part), 1);
      for (const [item, test] of picked) {
        if (test.root !== args.root) continue;
        profile.shown.add(item);
        const message = 'Piwi could not build the command that runs this test.';
        this.results.set(item.id, { state: 'errored', message });
        run.errored(item, new vscode.TestMessage(message));
      }
    }
    profile.starting = false;
    if (![...this.profiles].some((p) => p.starting)) this.endedEarly.clear();
    if (!profile.parts.length) {
      this.profiles.delete(profile);
      run.end();
      return;
    }
    this.finishProfile(profile);
    token.onCancellationRequested(() => {
      for (const execution of vscode.tasks.taskExecutions) {
        const definition = execution.task.definition;
        if (definition.type === RUN_TASK_TYPE && profile.parts.some((p) => p.ref === definition.ref)) {
          execution.terminate();
        }
      }
    });
  }
}

/**
 * An answer with each spec's URI spelled as VS Code spells a document's (`c%3A`, `%40`…), which the tree compares
 * them with: the service spells them as Node does.
 */
function asEditorUris(answer: TestItemsResult): TestItemsResult {
  return {
    contexts: answer.contexts.map((c) => ({
      ...c,
      specs: c.specs.map((s) => ({ ...s, uri: vscode.Uri.parse(s.uri).toString() })),
    })),
  };
}

/** A tree that could not be drawn stays as it was; the reads after it go on. */
function drawFailed(e: unknown): void {
  console.error('Piwi: the Testing view could not be drawn:', e);
}

/** Whether a document is a spec on disk: the service answers for those under a Playwright config's folder. */
function isSpec(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' && SPEC_FILE.test(document.uri.path);
}
