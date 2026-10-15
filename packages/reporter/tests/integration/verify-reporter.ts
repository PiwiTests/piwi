import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { RunSampler } from '../../src/internal/collect/process-sampler.js';
import { CoverageCollection } from '../../src/internal/collect/test-coverage.js';
import type { CollectedTestCase } from '../../src/types/collected.js';
import type { ResourceCensus } from '../../src/internal/capture/resource-ledger.js';
import { PIWI_RESOURCES_RESULTS_ENV } from '../../src/internal/config/env.js';
import {
  buildResourceReport,
  formatResourceSummary,
  parseResourceCensus,
  parseResourceResults,
  type ResourceFinding,
} from '../../src/internal/collect/resource-verdicts.js';
import { API_BACKEND_ENV, API_BACKEND_FILES, backendLogsOf } from './api-backend.js';

/** Every step of a result, depth first. */
function allSteps(steps: TestStep[]): TestStep[] {
  return steps.flatMap((step) => [step, ...allSteps(step.steps)]);
}

/** The `// site:<name>` markers of `resources.spec.ts`, as `resources.spec.ts:<line>` by name. */
function siteMarkers(): Map<string, string> {
  const sites = new Map<string, string>();
  const lines = fs.readFileSync(path.join(__dirname, 'resources.spec.ts'), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = /\/\/ site:([\w-]+)/.exec(line);
    if (match) sites.set(match[1]!, `resources.spec.ts:${index + 1}`);
  });
  return sites;
}

/**
 * Inspects the real `piwi-*` testInfo attachments produced by the capture
 * fixtures (`piwiFixtures`) at the end of each test and fails the whole
 * `playwright test` run on a mismatch. This is the integration-level
 * counterpart to the unit tests in `tests/capture-fixtures.spec.ts` and
 * `tests/locator-healing.spec.ts` — it exercises the real Proxy-wrapped
 * locator, network, console, web-vitals, and failure-time (ARIA snapshot +
 * locator suggestion) capture end to end against a live browser, which those
 * (necessarily mocked) unit tests cannot.
 *
 * Test roles are keyed off `test.expectedStatus`/title:
 *   - `expectedStatus === 'failed'` → the failure-capture test (ARIA + suggestion);
 *   - title starting `teardown race guard` → the teardown-race stress runs;
 *   - title starting `assertion-only` → the assertion-capture test (`_expect`);
 *   - title starting `seeded probe` → the in-page probe install (asserts in the test itself);
 *   - title starting `resources:` → the resource ledger (`resources.spec.ts`), checked in `onEnd`;
 *   - title starting `api:` → the API tests (in `capture.spec.ts`), whose server coverage is collected as
 *     the reporter collects it and checked in `onEnd`;
 *   - otherwise → the main capture test (locators + network + console + web vitals).
 *
 * Every test, whatever its role, must attach its `piwi-resources` census. The
 * shutdown census of each worker lands in the file `onBegin` names in
 * `PIWI_RESOURCES_RESULTS`, as it does for the dashboard reporter, and `onEnd`
 * reaches the findings from all of them.
 */
export default class VerifyCaptureReporter implements Reporter {
  private failures: string[] = [];
  private sawMainCapture = false;
  private sawFailureCapture = false;
  private sawAssertionCapture = false;
  private sawSeededProbe = false;
  private stressRuns = 0;
  private resourceTests = 0;
  private apiTests = 0;
  /** The API tests' coverage, collected from the stub backend as the reporter collects it. */
  private readonly coverage = new CoverageCollection({
    settings: { browser: 'off', server: 'files' },
    baseUrls: [],
    configDir: __dirname,
  });
  private apiCoverage: Array<{ title: string; testCase: CollectedTestCase }> = [];
  private censuses: ResourceCensus[] = [];
  private censusByTitle = new Map<string, ResourceCensus>();
  private resourcesFile = path.join(os.tmpdir(), `piwi-resources-verify-${process.pid}.jsonl`);

  private sampler: RunSampler | null = null;

  onBegin(config: FullConfig): void {
    // Workers start after this hook and inherit the variable.
    fs.rmSync(this.resourcesFile, { force: true });
    process.env[PIWI_RESOURCES_RESULTS_ENV] = this.resourcesFile;
    // Memory is read on every sample, so a worker that lives a few seconds is read too.
    this.sampler = new RunSampler({ outputDirs: config.projects.map((project) => project.outputDir), heavyEvery: 1 });
    this.sampler.start();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const byName = (name: string) => result.attachments.find((a) => a.name === name);
    const assert = (cond: boolean, msg: string) => {
      if (!cond) this.fail(`[${test.title}] ${msg}`);
    };

    // ── Resource census: attached by every test, after its fixtures tore down ─
    const census = parseResourceCensus(byName('piwi-resources')?.body);
    assert(!!census, 'expected a piwi-resources census');
    if (census) {
      assert(census.test?.title === test.title, `the census should close this test, got "${census.test?.title}"`);
      this.censuses.push(census);
      this.censusByTitle.set(test.title, census);
    }
    if (test.title.startsWith('resources:')) {
      assert(result.status === 'passed', `expected to pass, got ${result.status}`);
      this.resourceTests += 1;
      return;
    }
    if (test.title.startsWith('api:')) {
      this.checkApiTest(test, result);
      return;
    }

    // ── Failure-only capture: ARIA snapshot + fresh locator suggestion ──────
    // These are produced only when a test actually fails, so this one is marked
    // test.fail() and its "failed" status is the expected outcome.
    if (test.expectedStatus === 'failed') {
      assert(result.status === 'failed', `expected an actual failure to drive failure capture, got ${result.status}`);

      assert(!!byName('piwi-aria-snapshot'), 'expected a piwi-aria-snapshot attachment on the failing test');

      // The wrapped action keeps its own name and its call site: the error
      // reads `locator.click`, and points at the spec, never at the wrapper.
      const error = result.errors[0];
      assert(
        !!error?.message?.includes('locator.click:'),
        `the wrapped action's error should name locator.click, got: ${error?.message?.split('\n')[0]}`,
      );
      assert(
        !!error?.location?.file.endsWith('capture.spec.ts'),
        `the error should point at the spec, got ${error?.location?.file}`,
      );

      const suggestion = byName('piwi-locator-suggestion');
      assert(!!suggestion, 'expected a piwi-locator-suggestion attachment on the failing test');
      if (suggestion?.body) {
        const parsed = JSON.parse(suggestion.body.toString('utf8')) as { failing?: string; suggestions?: string[] };
        assert(
          Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0,
          'suggestion should list at least one replacement locator',
        );
      }
      this.sawFailureCapture = true;
      return;
    }

    // Every non-failing test must pass — a teardown-race regression surfaces as
    // a spurious "not bound in the connection" failure here.
    if (result.status !== 'passed') {
      this.fail(`[${test.title}] expected to pass, got ${result.status}`);
      return;
    }

    // Every passing test drives a locator action, so all must attach locators.
    assert(!!byName('piwi-locators'), 'expected a piwi-locators attachment');

    // ── Teardown-race stress runs: passing (checked above) is the whole point ─
    if (test.title.startsWith('teardown race guard')) {
      this.stressRuns += 1;
      return;
    }

    // ── Seeded probe: the check is the test's own expect(); passing is it ────
    if (test.title.startsWith('seeded probe')) {
      this.sawSeededProbe = true;
      return;
    }

    // ── Assertion-only capture: a passing expect() must record the element ───
    if (test.title.startsWith('assertion-only')) {
      const locators = byName('piwi-locators');
      if (locators?.body) {
        const snapshots = JSON.parse(locators.body.toString('utf8')) as Array<{
          location: string;
          used: { method: string; args: unknown[] };
          element: { tagName: string; attributes: Record<string, unknown> } | null;
          alternatives: unknown[];
        }>;
        const email = snapshots.find((s) => s.element?.attributes?.['id'] === 'email');
        assert(!!email, 'expected an element-bearing snapshot for the asserted (never acted-on) Email field');
        assert(email?.used.method === 'getByLabel', 'assertion snapshot should keep the locator the test used');
        assert(email?.element?.tagName === 'input', 'assertion-captured element should record its tag name');
        assert(
          Array.isArray(email?.alternatives) && email!.alternatives.length > 0,
          'assertion-captured element should have generated locator alternatives',
        );
        assert(
          typeof email?.location === 'string' && email.location.includes('capture.spec.ts'),
          'assertion snapshot should record the expect() call site',
        );
        assert(
          !snapshots.some((s) => JSON.stringify(s.used).includes('Nonexistent')),
          'a passing negated assertion must not capture its target',
        );
      }
      this.sawAssertionCapture = true;
      return;
    }

    // ── Main capture test: assert the full passing-path attachment set ───────
    // The capture's own reads are internal calls, and a wrapped action is
    // located at the test's line: nothing Piwi does shows up as a step.
    const steps = allSteps(result.steps);
    const click = steps.find((step) => step.title.startsWith('Click') || step.title.startsWith('locator.click'));
    assert(
      !!click?.location?.file.endsWith('capture.spec.ts'),
      `the wrapped click step should be located in the spec, got ${click?.location?.file}`,
    );
    assert(
      !steps.some((step) => step.category === 'pw:api' && /evaluate|aria snapshot/i.test(step.title)),
      'the element probe must not be recorded as a step',
    );

    // The clicked Save button still holds focus and the mouse at test end.
    const pageState = byName('piwi-page-state');
    assert(!!pageState?.body, 'expected a piwi-page-state attachment');
    if (pageState?.body) {
      const state = JSON.parse(pageState.body.toString('utf8')) as {
        focus?: { element: { path: string; label: string } };
        hover?: { path: string; label: string };
      };
      assert(
        state.focus?.element.label === 'button#save' && state.focus.element.path === 'html:1/body:1/button:1',
        `the clicked button should hold focus at test end, got ${JSON.stringify(state.focus)}`,
      );
      assert(
        state.hover?.label === 'button#save',
        `the mouse should be over the clicked button, got ${JSON.stringify(state.hover)}`,
      );
    }

    const locators = byName('piwi-locators');
    if (locators?.body) {
      const snapshots = JSON.parse(locators.body.toString('utf8')) as Array<{
        location: string;
        element: { tagName: string; attributes: Record<string, unknown> } | null;
        alternatives: unknown[];
      }>;
      assert(Array.isArray(snapshots) && snapshots.length > 0, 'piwi-locators body should be a non-empty array');
      const saveBtn = snapshots.find((s) => s.element?.attributes?.['data-testid'] === 'save-btn');
      assert(!!saveBtn, 'expected a captured snapshot for the save-btn locator');
      assert(saveBtn?.element?.tagName === 'button', 'captured element should record its tag name');
      // The exact spec file, not just any location — the bundled dist's own
      // frames must never be mistaken for the call site (self-file skip).
      assert(
        typeof saveBtn?.location === 'string' && saveBtn.location.includes('capture.spec.ts'),
        'snapshot should record the action call site in the spec file',
      );
      assert(
        Array.isArray(saveBtn?.alternatives) && saveBtn!.alternatives.length > 0,
        'captured element should have generated locator alternatives',
      );
    }

    const network = byName('piwi-network');
    assert(!!network, 'expected a piwi-network attachment');
    if (network?.body) {
      const requests = JSON.parse(network.body.toString('utf8')) as Array<{
        url: string;
        method: string;
        status: number;
      }>;
      const ping = requests.find((r) => r.url.includes('/api/ping'));
      assert(!!ping, 'expected a captured network request for /api/ping');
      assert(ping?.method === 'GET', 'captured request should record its method');
      assert(ping?.status === 200, 'captured request should record its response status');
    }

    // The request ids of the server coverage the page's document and fetch named, under their origin.
    const coverageRequests = byName('piwi-server-coverage-requests');
    assert(!!coverageRequests, 'expected a piwi-server-coverage-requests attachment');
    if (coverageRequests?.body) {
      const byOrigin = JSON.parse(coverageRequests.body.toString('utf8')) as Record<string, string[]>;
      const origins = Object.keys(byOrigin);
      assert(
        origins.length === 1 && /^http:\/\/127\.0\.0\.1:\d+$/.test(origins[0]!),
        `expected one origin, got ${origins.join(', ')}`,
      );
      const ids = byOrigin[origins[0]!] ?? [];
      assert(
        ids.length === 2 &&
          ids.some((id) => id.startsWith('itest.doc-')) &&
          ids.some((id) => id.startsWith('itest.ping-')),
        `expected the document's and the fetch's request ids, got ${ids.join(', ')}`,
      );
    }

    const console_ = byName('piwi-console');
    assert(!!console_, 'expected a piwi-console attachment');
    if (console_?.body) {
      const entries = JSON.parse(console_.body.toString('utf8')) as Array<{ type: string; text: string }>;
      const errorEntry = entries.find((e) => e.type === 'error' && e.text.includes('integration-test-console-error'));
      assert(!!errorEntry, 'expected a captured console.error entry');
    }

    const vitals = byName('piwi-web-vitals');
    assert(!!vitals, 'expected a piwi-web-vitals attachment');
    if (vitals?.body) {
      const wv = JSON.parse(vitals.body.toString('utf8')) as {
        navigation: unknown | null;
        paint: Record<string, number>;
      };
      assert(
        wv.navigation !== null || Object.keys(wv.paint ?? {}).length > 0,
        'web vitals should record navigation timing or paint entries',
      );
    }

    this.sawMainCapture = true;
  }

  async onEnd(_result: FullResult): Promise<{ status: 'failed' } | void> {
    if (!this.sawMainCapture) this.fail('the main capture test did not run — nothing verified its attachments');
    if (!this.sawFailureCapture) this.fail('the failure-capture test did not run — ARIA/suggestion unverified');
    if (!this.sawAssertionCapture) this.fail('the assertion-capture test did not run — _expect capture unverified');
    if (!this.sawSeededProbe) this.fail('the seeded-probe test did not run — the in-page probe install is unverified');
    if (this.stressRuns < 1) this.fail('the teardown-race stress tests did not run');
    if (this.apiTests < 2) this.fail('the API tests did not run — the capture of API calls is unverified');
    await this.checkApiCoverage();
    this.checkResources();
    await this.checkSampler();

    if (this.failures.length > 0) {
      console.error(`\n[verify-reporter] ${this.failures.length} check(s) FAILED:`);
      for (const f of this.failures) console.error(`  ✗ ${f}`);
      // Return a failing status so the run exits non-zero even though the
      // intentionally-failing test's outcome is "expected".
      return { status: 'failed' };
    }
    console.log(`\n[verify-reporter] all capture-fixtures integration checks passed (${this.stressRuns} stress runs).`);
  }

  /**
   * An API test (`api:`): its calls in the network capture, with the
   * backend's logs and no resource type, the coverage ids of their responses
   * under the backend's origin, and each call's step at the spec's line. A call
   * Playwright fails for its status keeps its name and line, and is recorded
   * with that status. The passing test's server coverage is then collected.
   */
  private checkApiTest(test: TestCase, result: TestResult): void {
    const assert = (cond: boolean, msg: string) => {
      if (!cond) this.fail(`[${test.title}] ${msg}`);
    };
    this.apiTests += 1;
    const backend = process.env[API_BACKEND_ENV] ?? '';
    assert(backend !== '', `the stub backend should have set ${API_BACKEND_ENV} in the runner`);
    const attachment = (name: string) => result.attachments.find((a) => a.name === name)?.body?.toString('utf8');
    const network = JSON.parse(attachment('piwi-network') ?? '[]') as Array<Record<string, unknown>>;

    if (test.expectedStatus === 'failed') {
      assert(result.status === 'failed', `expected the call to fail the test, got ${result.status}`);
      const error = result.errors[0];
      assert(
        !!error?.message?.includes('apiRequestContext.get: 404 Not Found'),
        `the call's error should keep its name, got: ${error?.message?.split('\n')[0]}`,
      );
      assert(
        !!error?.location?.file.endsWith('capture.spec.ts'),
        `the error should point at the spec, got ${error?.location?.file}`,
      );
      const missing = network.find((entry) => entry.url === `${backend}/api/missing`);
      assert(
        missing?.status === 404 && !('failure' in missing),
        `expected the call with its 404 status: ${JSON.stringify(network)}`,
      );
      return;
    }

    assert(result.status === 'passed', `expected to pass, got ${result.status}`);
    const expected = [
      ['GET', '/api/items', 200],
      ['POST', '/api/orders', 201],
      ['GET', '/api/items?via=own', 200],
    ] as const;
    assert(network.length === expected.length, `expected ${expected.length} calls: ${JSON.stringify(network)}`);
    for (const [method, path, status] of expected) {
      const entry = network.find((e) => e.url === `${backend}${path}`);
      assert(
        entry?.method === method &&
          entry.status === status &&
          entry.contentType === 'application/json' &&
          typeof entry.duration === 'number' &&
          typeof entry.startTime === 'number' &&
          !('resourceType' in entry) &&
          JSON.stringify(entry.serverLogs) === JSON.stringify(backendLogsOf(path.split('?')[0]!)),
        `${method} ${path}: ${JSON.stringify(entry)}`,
      );
    }

    const ids = (JSON.parse(attachment('piwi-server-coverage-requests') ?? '{}') as Record<string, string[]>)[backend];
    assert(
      ids?.length === 3,
      `expected the three responses' coverage ids under ${backend}, got ${JSON.stringify(ids)}`,
    );

    const calls = allSteps(result.steps).filter(
      (step) => step.category === 'pw:api' && /^(GET|POST)\b/.test(step.title),
    );
    assert(
      calls.length === 3 && calls.every((step) => step.location?.file.endsWith('capture.spec.ts')),
      `each call's step should be located in the spec: ${JSON.stringify(calls.map((s) => [s.title, s.location?.file]))}`,
    );

    const testCase = {} as CollectedTestCase;
    assert(this.coverage.apply(testCase, result.attachments) !== null, 'the test should wait for its server coverage');
    this.apiCoverage.push({ title: test.title, testCase });
  }

  /** The server coverage of the API tests, collected from the stub backend: the files their calls ran. */
  private async checkApiCoverage(): Promise<void> {
    await this.coverage.settle();
    this.coverage.close();
    const expected = [...new Set(Object.values(API_BACKEND_FILES))].sort();
    for (const { title, testCase } of this.apiCoverage) {
      const paths = (testCase.coverage?.files ?? []).map((file) => file.path).sort();
      if (JSON.stringify(paths) !== JSON.stringify(expected) || testCase.coverage?.incomplete) {
        this.fail(
          `[${title}] expected the server coverage of ${expected.join(', ')}: ${JSON.stringify(testCase.coverage)}`,
        );
      }
    }
  }

  /**
   * The resource ledger end to end: what each `resources:` test recorded about
   * the objects it opened, then the findings reached from every census: the
   * leaky tests' findings at their lines, nothing from the clean tests or from
   * `capture.spec.ts`.
   */
  private checkResources(): void {
    const check = (cond: boolean, msg: string) => {
      if (!cond) this.fail(`[resources] ${msg}`);
    };
    if (this.resourceTests === 0) return check(false, 'the resources tests did not run');
    const sites = siteMarkers();
    const at = (name: string) => sites.get(name) ?? `<no site:${name} marker>`;
    const born = (title: string) => this.censusByTitle.get(title)?.born ?? [];
    const opensAt = (site: string | null, name: string) => !!site?.endsWith(at(name));

    // ── Provenance, as the workers recorded it ──────────────────────────────
    const context = born('resources: leaks a context').find((b) => b.kind === 'context');
    check(
      !!context && context.phase === 'test' && context.fixture === null && opensAt(context.site, 'context'),
      `a context opened in a test body: ${JSON.stringify(context)}`,
    );
    const newPage = born('resources: leaks a page from browser.newPage');
    const implicit = newPage.find((b) => b.kind === 'context');
    const ownPage = newPage.find((b) => b.kind === 'page');
    check(!!implicit?.implicit, `browser.newPage() should mark its context implicit: ${JSON.stringify(implicit)}`);
    check(
      !!ownPage && ownPage.parent === implicit?.id && opensAt(ownPage.site, 'new-page'),
      `the page of browser.newPage(): ${JSON.stringify(ownPage)}`,
    );
    const api = born('resources: leaks an API request context').find((b) => b.kind === 'request');
    check(!!api && opensAt(api.site, 'request'), `request.newContext(): ${JSON.stringify(api)}`);
    const launched = born('resources: leaks a launched browser').find((b) => b.kind === 'browser');
    check(
      !!launched && launched.phase === 'test' && launched.fixture === null && opensAt(launched.site, 'launch'),
      `chromium.launch() in a test: ${JSON.stringify(launched)}`,
    );
    const popupTest = born('resources: leaves a popup of a worker-scoped page open');
    const shared = popupTest.find((b) => b.kind === 'page' && b.fixture?.title === 'sharedPage');
    const popup = popupTest.find((b) => b.kind === 'page' && b.opener !== undefined);
    check(
      !!shared && shared.fixture!.worker && opensAt(shared.site, 'shared-page'),
      `a worker fixture's page: ${JSON.stringify(shared)}`,
    );
    check(
      !!popup && popup.opener === shared?.id && popup.trigger === 'locator.click' && opensAt(popup.site, 'popup'),
      `a popup, with its opener and the click that opened it: ${JSON.stringify(popup)}`,
    );
    const idleTest = this.censusByTitle.get('resources: opens a page it never uses');
    const idlePage = idleTest?.born.find((b) => b.kind === 'page');
    check(
      !!idlePage && idlePage.phase === 'beforeEach' && idlePage.fixture?.title === 'page' && !idlePage.fixture.worker,
      `the page fixture, set up for a beforeEach: ${JSON.stringify(idlePage)}`,
    );
    check(
      !!idleTest?.closed.some((c) => c.id === idlePage?.id && c.used === false),
      'the page fixture of an API-only test should close unused',
    );
    for (const title of [
      'resources: clean, evaluates on a page it never navigates',
      'resources: clean, sets the content of its page',
    ]) {
      const page = this.censusByTitle.get(title);
      check(!!page?.closed.some((c) => c.used === true), `[${title}] its page should close used`);
    }
    const beforeAll = born('resources: uses the beforeAll context').find((b) => b.kind === 'context');
    check(
      !!beforeAll && beforeAll.phase === 'beforeAll' && opensAt(beforeAll.site, 'before-all'),
      `a beforeAll context: ${JSON.stringify(beforeAll)}`,
    );
    const closedInAfterAll = this.censuses.flatMap((census) =>
      census.born.filter((b) => opensAt(b.site, 'before-all-closed')).map((b) => ({ worker: census.worker, id: b.id })),
    )[0];
    const afterAllClose = this.censuses
      .filter((census) => census.worker === closedInAfterAll?.worker)
      .flatMap((census) => census.closed)
      .find((c) => c.id === closedInAfterAll?.id);
    check(afterAllClose?.phase === 'afterAll', `a context closed in afterAll: ${JSON.stringify(afterAllClose)}`);

    // ── What each test cost its worker, and the pages that outlived it ──────
    for (const [title, census] of this.censusByTitle) {
      const worker = census.metrics?.worker;
      check(
        !!worker && worker.loopUtilization >= 0 && worker.loopUtilization <= 1 && worker.cpuMs >= 0,
        `[${title}] the census should carry the worker's metrics: ${JSON.stringify(census.metrics)}`,
      );
    }
    if (process.platform === 'linux') {
      check(
        this.censuses.some(
          (c) => (c.metrics?.roles?.renderer?.cpuMs ?? 0) > 0 && (c.metrics?.roles?.renderer?.peakRssMb ?? 0) > 0,
        ),
        'some census should carry the CPU and peak memory of the renderers the worker started',
      );
    }
    const popupWorker = this.censusByTitle.get('resources: leaves a popup of a worker-scoped page open')?.worker;
    check(
      this.censuses.some(
        (c) => c.worker === popupWorker && c.open.some((o) => o.id === popup?.id && (o.main?.heapMb ?? 0) > 0),
      ),
      'the popup that outlived its test should be read over CDP at the next censuses',
    );

    // ── Findings, from every census and each worker's shutdown census ───────
    const shutdown = fs.existsSync(this.resourcesFile)
      ? parseResourceResults(fs.readFileSync(this.resourcesFile, 'utf8'))
      : [];
    fs.rmSync(this.resourcesFile, { force: true });
    check(shutdown.length > 0, 'expected a shutdown census from each worker');
    const report = buildResourceReport({ censuses: [...this.censuses, ...shutdown] });
    console.log(`\n[verify-reporter] ${formatResourceSummary(report, 'report').join('\n')}`);

    const expected: Array<[string, (f: ResourceFinding) => boolean]> = [
      [
        'a context left open',
        (f) =>
          f.verdict === 'leaked' &&
          f.kind === 'context' &&
          f.where.endsWith(at('context')) &&
          f.pages === 1 &&
          (f.afterTestCpuMs ?? 0) > 0,
      ],
      [
        'the page of browser.newPage()',
        (f) => f.verdict === 'leaked' && f.kind === 'page' && f.where.endsWith(at('new-page')),
      ],
      [
        'an API request context',
        (f) => f.verdict === 'leaked' && f.kind === 'request' && f.where.endsWith(at('request')),
      ],
      [
        'a launched browser, with its page',
        (f) => f.verdict === 'leaked' && f.kind === 'browser' && f.where.endsWith(at('launch')) && f.pages === 1,
      ],
      [
        'a popup',
        (f) =>
          f.verdict === 'leaked' && f.where.startsWith('popup after locator.click') && f.where.endsWith(at('popup')),
      ],
      [
        'a beforeAll context past its describe',
        (f) =>
          f.verdict === 'leaked' &&
          f.scope === 'describe' &&
          f.where.endsWith(at('before-all')) &&
          f.detail === 'beforeAll of "resources: a beforeAll context without afterAll"',
      ],
      [
        'one listener per test on the shared page',
        (f) =>
          f.verdict === 'piling' &&
          f.where.startsWith('fixture "sharedPage" at ') &&
          f.where.endsWith(at('shared-page')) &&
          f.growth?.what === 'listeners' &&
          f.growth.to - f.growth.from === 3,
      ],
      [
        'a server left listening',
        (f) =>
          f.verdict === 'handle' &&
          f.where === 'TCPServerWrap' &&
          !!f.detail?.includes('resources: leaves a server listening'),
      ],
      ['the unused page fixture', (f) => f.verdict === 'idle' && f.where === 'fixture "page"' && f.count === 1],
    ];
    const matched = new Set<ResourceFinding>();
    for (const [what, matches] of expected) {
      const finding = report.findings.find((f) => !matched.has(f) && matches(f));
      check(!!finding, `expected a finding for ${what}`);
      if (finding) matched.add(finding);
    }
    for (const finding of report.findings) {
      check(matched.has(finding), `unexpected finding: ${JSON.stringify(finding)}`);
    }
  }

  /** The run sampler against the run's real processes: Playwright's workers, Chromium's browser and renderers. */
  private async checkSampler(): Promise<void> {
    const profile = await this.sampler!.stop();
    const check = (cond: boolean, msg: string) => {
      if (!cond) this.fail(`[sampler] ${msg}`);
    };
    check(profile.machine.cores > 0 && profile.cpu.busyPct !== null, 'the machine should be measured');
    if (process.platform !== 'linux') return;
    const roles = profile.cpu.byRole ?? {};
    for (const role of ['worker', 'browser', 'renderer'] as const) {
      check((roles[role]?.cpuMs ?? 0) > 0, `the ${role} processes should have used CPU: ${JSON.stringify(roles)}`);
    }
    check(
      profile.memory.kind === 'pss' && (profile.memory.peakBytes ?? 0) > 0,
      `memory: ${JSON.stringify(profile.memory)}`,
    );
    check(profile.disk.lowestFreeBytes !== null, 'free space should be measured');
    const series = this.sampler!.timedSeries();
    check(
      series.cpuPct.length > 0 && series.memoryBytes.length > 0,
      `CPU and memory should be read over time: ${series.cpuPct.length} and ${series.memoryBytes.length} points`,
    );
    check(
      series.workers.length > 0 && series.workers.every((w) => w.cpuCores.length > 0 && w.memoryBytes.length > 0),
      `each worker process should be read with its browsers: ${JSON.stringify(series.workers.map((w) => [w.pid, w.cpuCores.length, w.memoryBytes.length]))}`,
    );
  }

  private fail(msg: string): void {
    this.failures.push(msg);
  }
}
