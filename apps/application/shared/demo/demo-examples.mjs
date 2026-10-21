/**
 * The demo examples: concrete screens of the live demo that a docs page links
 * to. A feature page renders its own with `<DemoExamples />`, under its
 * `## Try it in the demo` heading.
 *
 * Plain ESM so the seed generator's world (plain Node), the tests and the docs
 * site (through the `#shared` alias) read the same file. Each entry's
 * `expect` says what the generated seed must hold for its route to show what
 * `shows` promises; `tests/unit/demo-seed-consistency.test.ts` checks every one
 * against the seed, so a seed change that moves an id fails there, naming the
 * example. The demo's guided tour states what its stops open in the same
 * vocabulary (`app/utils/demo-tour/profiles.ts`), checked the same way. The
 * vocabulary is closed:
 *
 * - `testCase: { id, title }`, `execution: { id, title }`, `project: { id, name }`,
 *   `cluster: { id, story }`, `run: { id, project }`: the entity the route opens
 *   (its id is the one in the route), by id and by what identifies it in the
 *   seed (a test title, the title of the execution's test, a project name, a
 *   failure story key, the run's project name).
 * - `diagnosis: 'with-patch' | 'none'`: the cluster has a completed stored AI
 *   diagnosis with a suggested patch, or no stored diagnosis at all.
 * - `fixLanded: true`: the cluster's fix has landed.
 * - `issue: { key, status }`: the cluster is tracked in the Jira issue with that
 *   key, in that status: its newest tracker link, the one its pages show.
 * - `lab`: the test's Flake Lab state (`#shared/flake-lab`'s `FlakeLabTestState`).
 * - `resources: 'leaky'`: the run's resource report names at least one leak.
 * - `incident: true`: the run is flagged as an environment incident.
 * - `coverageGap: 'restarted' | 'unreachable'`: part of the run's server
 *   coverage is missing, for that reason: a backend restarted during the run,
 *   or was unreachable at its end.
 * - `gaps: { detectors }`: the project has an open scenario gap (or finding)
 *   from each named detector.
 * - `suspects: { path, granularity? }`: the cluster's suspect lines start
 *   with that file, at that granularity when one is given: its story's failing
 *   tests recorded coverage of it (with lines for `lines`), and the demo's
 *   canned changes change it.
 * - `coverage: { serverFiles, browserFiles, runCoverage? }`: the execution
 *   recorded coverage of that many server files, each with executed lines, and
 *   that many browser files; with `runCoverage`, its run's own coverage holds
 *   each of those server files with its executable lines.
 * - `fileCoverage: { path, tests, executable? }`: on the project's default
 *   branch, that many tests recorded coverage of the file, every one by line
 *   at a git blob; with `executable`, a run's coverage holds the file's
 *   executable lines at that blob.
 * - `combinedCoverage: { suites, filesWithoutData }`: the project's newest
 *   commit with coverage reports combines that many suites (its reports, and
 *   `e2e` when a complete run of the commit recorded run coverage), and its
 *   inventory names that many files no suite names.
 * - `supersededCoverage: { branch, carried }`: the branch's two newest commits
 *   with coverage reports share a suite, so the newer supersedes the older's
 *   report of it, and the older alone has `carried`, which the newer carries
 *   forward from it.
 * - `insight: 'divergence' | 'path-variation'`: the coverage insight the route
 *   shows holds: the execution failed with coverage and its test has an
 *   earlier passing execution with coverage; or the test has at least 8
 *   executions with coverage.
 */

/** @type {readonly import('./demo-examples.d.mts').DemoExample[]} */
export const DEMO_EXAMPLES = [
  {
    id: 'environment-incident-run',
    doc: 'features/environment-incidents',
    title: 'E2E Checkout › a run against staging while it was down',
    shows:
      'Ten of eleven tests failed navigating to staging, so the run is an environment incident: not counted, with one incident marker.',
    route: '/test-runs/14',
    expect: { run: { id: 14, project: 'e2e-checkout' }, incident: true },
  },
  {
    id: 'ai-diagnosis-stored',
    doc: 'features/ai-diagnosis',
    title: 'Web Dashboard › Users table paginates 25 rows per page',
    shows:
      'A stored diagnosis traces the 50 user rows (51 with the header) to the API’s default page size and suggests a patch; the fix has since landed.',
    route: '/failure-clusters/10',
    expect: { cluster: { id: 10, story: 'users-table-page-size' }, diagnosis: 'with-patch', fixLanded: true },
  },
  {
    id: 'suspect-lines-server',
    doc: 'features/ai-diagnosis',
    title: 'Web Dashboard › Users table paginates 25 rows per page',
    shows:
      'The dashboard’s ASP.NET Core API records server coverage by line: of the 13 lines changed in the range, the failing test ran 3, the statements of UsersEndpoints.cs that size, fetch and return the page, which two passing tests ran too; the What changed line names them, the diff marks them, and the diagnosis context and the fix plan list them.',
    route: '/failure-clusters/10',
    expect: {
      cluster: { id: 10, story: 'users-table-page-size' },
      suspects: { path: 'api/Users/UsersEndpoints.cs', granularity: 'lines' },
    },
  },
  {
    id: 'suspect-lines-cluster',
    doc: 'features/ai-diagnosis',
    title: 'UI Components › Modal opens and closes correctly',
    shows:
      'Browser coverage names files: of the two files changed in the range, the failing modal tests ran the modal controller and no passing test did, so its whole hunk heads the suspect lines on the What changed line, its card and the diagnosis context.',
    route: '/failure-clusters/5',
    expect: {
      cluster: { id: 5, story: 'modal-never-opens' },
      suspects: { path: 'src/components/modal-controller.ts', granularity: 'files' },
    },
  },
  {
    id: 'execution-coverage-server',
    doc: 'features/code-reach',
    title: 'Web Dashboard › Users table paginates 25 rows per page: the server lines this test ran',
    shows:
      'The Source tab’s Coverage section lists the five files of the ASP.NET Core API the test ran, 20 lines, the users endpoints first with the suspect lines it ran, then the three browser files of the users page; open a server file to read its source with the lines the test ran marked, and the executable lines it did not run in a lighter mark.',
    route: '/test-run-cases/711?evidence=source',
    expect: {
      execution: { id: 711, title: 'Users table paginates 25 rows per page' },
      coverage: { serverFiles: 5, browserFiles: 3, runCoverage: true },
    },
  },
  {
    id: 'file-coverage-server',
    doc: 'features/code-reach',
    title: 'Web Dashboard › UsersEndpoints.cs: which tests run each line',
    shows:
      'The users endpoints of the ASP.NET Core API at the version its tests ran, each line marked with how many of the three users tests ran it and the executable lines none runs; select a line to list the tests that ran it, with their latest outcome.',
    route: '/projects/5/coverage?file=api/Users/UsersEndpoints.cs',
    expect: {
      project: { id: 5, name: 'web-dashboard' },
      fileCoverage: { path: 'api/Users/UsersEndpoints.cs', tests: 3, executable: true },
    },
  },
  {
    id: 'run-coverage-incomplete',
    doc: 'features/server-coverage',
    title: 'Web Dashboard › a run whose backend restarted',
    shows:
      'The ASP.NET Core API restarted halfway through the run: its header says the coverage is incomplete, and the commit’s combined coverage notes that its e2e suite may read low.',
    route: '/test-runs/63',
    expect: { run: { id: 63, project: 'web-dashboard' }, coverageGap: 'restarted' },
  },
  {
    id: 'combined-coverage',
    doc: 'features/combined-coverage',
    title: 'Web Dashboard › every suite’s coverage of one commit',
    shows:
      'The back end’s and the front end’s unit tests and the Playwright run of one commit, counted on the span table’s lines: the share each suite ran, a folder’s files, and the two tracked files no suite names.',
    route: '/projects/5/coverage',
    expect: { project: { id: 5, name: 'web-dashboard' }, combinedCoverage: { suites: 3, filesWithoutData: 2 } },
  },
  {
    id: 'combined-coverage-notes',
    doc: 'features/combined-coverage',
    title: 'Web Dashboard › a branch’s coverage, carried and superseded',
    shows:
      'The newest push of develop uploaded the front end’s unit tests only: the notes above its numbers say the back end’s suite is carried from the push before, and link to it, whose file detail went when this push arrived: it keeps only its totals.',
    route: '/projects/5/coverage?branch=develop',
    expect: {
      project: { id: 5, name: 'web-dashboard' },
      supersededCoverage: { branch: 'develop', carried: 'unit-back' },
    },
  },
  {
    id: 'coverage-divergence-order-flake',
    doc: 'features/coverage-insights',
    title: 'Web Dashboard › toggles dark mode: a failed attempt against its last pass',
    shows:
      'The Source tab compares the failed first attempt with the test’s last passing run: in the preferences endpoints, only the failure ran the conflict handler that keeps the stored theme, and only the pass published the change; open the file to see both marked.',
    route: '/test-run-cases/830?evidence=source',
    expect: {
      execution: { id: 830, title: 'toggles dark mode' },
      coverage: { serverFiles: 5, browserFiles: 0 },
      insight: 'divergence',
    },
  },
  {
    id: 'path-variation-order',
    doc: 'features/coverage-insights',
    title: 'Web Dashboard › toggles dark mode: a path that depends on the tests before it',
    shows:
      'Its Path variation card: in the 3 executions that started before updates the organization name finished, it ran the conflict handler, and only those failed, so its flaky root cause is order.',
    route: '/test-cases/53',
    expect: { testCase: { id: 53, title: 'toggles dark mode' }, insight: 'path-variation' },
  },
  {
    id: 'issue-tracked-cluster',
    doc: 'features/issue-tracking',
    title: 'API Integration › POST /auth/login returns 200 with valid credentials',
    shows:
      'The login 500 is tracked in DEMO-42, filed from Piwi and In Progress in Jira; its key follows the failure to its executions and the inbox.',
    route: '/failure-clusters/3',
    expect: { cluster: { id: 3, story: 'auth-login-500' }, issue: { key: 'DEMO-42', status: 'In Progress' } },
  },
  {
    id: 'ai-diagnosis-simulated',
    doc: 'features/ai-diagnosis',
    title: 'E2E Checkout › should complete checkout with Apple Pay',
    shows:
      'No stored diagnosis: the Diagnose with AI button streams a simulated one, built from the cluster’s own data.',
    route: '/failure-clusters/2',
    expect: { cluster: { id: 2, story: 'checkout-email-renamed' }, diagnosis: 'none' },
  },
  {
    id: 'flake-lab-reproduced',
    doc: 'features/flake-lab',
    title: 'E2E Checkout › should apply discount code',
    shows: 'A cart delay reproduced it 3 times in 4 against a clean control.',
    route: '/test-cases/9?tab=flakiness',
    expect: { testCase: { id: 9, title: 'should apply discount code' }, lab: 'reproduced' },
  },
  {
    id: 'flake-lab-verified-fix',
    doc: 'features/flake-lab',
    title: 'UI Components › Table pagination works correctly',
    shows:
      'One suspect reproduced it and one did not, a first fix still failed and the second is verified, so its quarantine is proposed for release.',
    route: '/test-cases/35?tab=flakiness',
    expect: { testCase: { id: 35, title: 'Table pagination works correctly' }, lab: 'verified' },
  },
  {
    id: 'flake-lab-tab',
    doc: 'features/flake-lab',
    title: 'UI Components › Flake Lab tab',
    shows: 'Where each flaky test of the project stands in the lab, and the command it needs next.',
    route: '/projects/3?tab=flake-lab',
    expect: { project: { id: 3, name: 'ui-components' } },
  },
  {
    id: 'resources-leaky-run',
    doc: 'features/resource-leaks',
    title: 'Web Dashboard › the newest run’s Resources tab',
    shows:
      'A login fixture leaves a context open per test: each worker’s open pages climb test after test, and the machine runs short of CPU.',
    route: '/test-runs/62?tab=resources',
    expect: { run: { id: 62, project: 'web-dashboard' }, resources: 'leaky' },
  },
  {
    id: 'resources-leaky-timeline',
    doc: 'features/cpu-memory-disk',
    title: 'Web Dashboard › the newest run’s Timeline tab',
    shows:
      'Above the worker rows, the machine’s CPU and the run’s memory climb with the pages its login fixture leaves open; hover them for the values at each moment.',
    route: '/test-runs/62?tab=workers',
    expect: { run: { id: 62, project: 'web-dashboard' }, resources: 'leaky' },
  },
  {
    id: 'test-map-web-dashboard',
    doc: 'features/scenario-gaps',
    title: 'Web Dashboard › Gaps',
    shows:
      'Ten tests against a whole admin console: routes never seen failing, pages linked and never visited, declared routes nothing requests, a save that passed while the backend logged an error, page-object methods no test calls, and the team’s verdicts on them. Under the list, map health shows probes short at 7 of 16 routes.',
    route: '/projects/5?tab=gaps',
    expect: {
      project: { id: 5, name: 'web-dashboard' },
      gaps: {
        detectors: [
          'success-only',
          'reachable-unvisited',
          'declared-never-hit',
          'single-covering-test',
          'passed-with-errors',
          'catalog-method-no-test-calls',
        ],
      },
    },
  },
  {
    id: 'probes-not-noticed',
    doc: 'features/probes',
    title: 'Web Dashboard › Gaps',
    shows:
      'Client probes the tests did not notice (an empty revenue response, a failed invitation, a stale organization name), an invite form that degraded when sendgrid failed, and a revenue page that threw when clickhouse failed.',
    route: '/projects/5?tab=gaps',
    expect: { project: { id: 5, name: 'web-dashboard' }, gaps: { detectors: ['not-noticed', 'not-handled'] } },
  },
];

/** The examples a docs page renders, in registry order. */
export function demoExamplesFor(doc) {
  return DEMO_EXAMPLES.filter((example) => example.doc === doc);
}
