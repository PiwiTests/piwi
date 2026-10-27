/**
 * The guide anchors of a test run's page (`/test-runs/[id]`), and of the Export
 * menu that the execution and failure cluster pages share with it.
 */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const RUNS_ANCHORS = [
  {
    id: 'run-header',
    kind: 'page',
    pages: ['/test-runs/[id]'],
    describes:
      'The run’s header: its status, number and label, the primary action, one line of facts, Details, and the count bar that filters the tests.',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-details',
    kind: 'action',
    pages: ['/test-runs/[id]'],
    describes:
      'The header’s Details button, which opens what the facts line leaves out: shards, versions, timings, retention, storage, tags and links.',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-shards',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-details' }],
    describes: 'The Shards line of the run’s Details: how many of the run’s shards have reported, out of all of them.',
    shownWhen: 'When the run is sharded.',
    help: 'run.partial',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-retention',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-details' }],
    describes:
      'The Retention line of the run’s Details: whether the run is kept forever, by whom and why, or left for retention to delete.',
    help: 'run.keep',
    doc: 'operate/storage#keeping-runs-forever',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-ingest',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-details' }],
    describes:
      'The Ingest line of the run’s Details: the steps, console entries and traces left out or rebuilt while storing the run, and how the reporter sent it.',
    shownWhen: 'When ingest left something out of the run or rebuilt it.',
    help: 'run.ingestHealth',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/4', expect: { run: { id: 4, project: 'e2e-checkout' } } },
  },
  {
    id: 'run-coverage-gaps',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-details' }],
    describes:
      'The Coverage line of the run’s Details: each backend whose server coverage is incomplete, because it restarted or was unreachable at the end.',
    shownWhen: 'When part of the run’s server coverage is missing.',
    help: 'run.coverageIncomplete',
    doc: 'features/server-coverage#limits',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' }, coverageGap: 'restarted' } },
  },
  {
    id: 'run-storage',
    kind: 'action',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-details' }],
    describes:
      'The Storage line of the run’s Details: the size and number of the files the run stored, which opens each of its reports.',
    shownWhen: 'When the run stored reports or test files.',
    doc: 'operate/storage',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-stored-artifacts',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-details' }, { open: 'run-storage' }],
    describes:
      'The run’s stored artifacts: each report uploaded with it, such as one HTML report per shard, and the test files, with their sizes.',
    shownWhen: 'When the run stored reports or test files.',
    help: 'run.reports',
    doc: 'guide/reporter#multiple-reports',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-links',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-details' }],
    describes:
      'The Links line of the run’s Details: the issues and other pages linked to the run, each with its provider, and the button to add one.',
    help: 'run.metadata',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'export-menu',
    kind: 'action',
    pages: ['/test-runs/[id]', '/test-run-cases/[id]', '/failure-clusters/[id]'],
    describes:
      'The Export button: an execution or a cluster as a file to read without Piwi, a failure for Piwi Picker’s Replay, a run’s or an execution’s Perfetto trace.',
    doc: 'features/offline-export',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'export-download',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ open: 'export-menu' }],
    describes:
      'The Download section of the Export menu: the investigation as one HTML page, a ZIP with every artifact, a PDF, Markdown or JSON.',
    help: 'export.offline',
    doc: 'features/offline-export#formats',
    sample: {
      route: '/test-run-cases/37',
      expect: { execution: { id: 37, title: 'should complete checkout with credit card' } },
    },
  },
  {
    id: 'export-replay',
    kind: 'block',
    pages: ['/test-run-cases/[id]'],
    reveal: [{ open: 'export-menu' }],
    describes:
      'The Replay section of the Export menu: the failure as a .piwibug bug report, whose steps Piwi Picker’s Replay plays in your own browser.',
    shownWhen: 'When the execution failed.',
    help: 'export.replay',
    doc: 'features/offline-export#replay-the-failure-in-a-browser',
    sample: {
      route: '/test-run-cases/37',
      expect: { execution: { id: 37, title: 'should complete checkout with credit card' } },
    },
  },
  {
    id: 'run-more-actions',
    kind: 'action',
    pages: ['/test-runs/[id]'],
    describes:
      'The run’s More actions menu: copy the run summary, refresh, keep the run forever or release it, and delete the run.',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-keep',
    kind: 'action',
    pages: ['/test-runs/[id]'],
    reveal: [{ open: 'run-more-actions' }],
    describes:
      'The More actions menu’s Keep forever entry, which exempts the run from retention and its cleanup, with an optional reason.',
    shownWhen: 'When the run is not kept yet.',
    doc: 'operate/storage#keeping-runs-forever',
    sample: { route: '/test-runs/63', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-incident',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    describes:
      'The line saying the run is an environment incident, why Piwi flagged it, and that verdicts comparing runs leave it out.',
    shownWhen: 'When the run is flagged as an environment incident.',
    doc: 'features/environment-incidents',
    sample: { route: '/test-runs/14', expect: { run: { id: 14, project: 'e2e-checkout' }, incident: true } },
  },
  {
    id: 'run-tests',
    kind: 'tab',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'test-cases' } }],
    describes:
      'The Tests tab: every execution of the run in the order it ran, searchable, filtered by status and grouped by cluster, file or lock.',
    help: 'run.test-cases',
    doc: 'reference/test-search',
    sample: { route: '/test-runs/63?tab=test-cases', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-tests-group-by',
    kind: 'action',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'test-cases' } }],
    describes:
      'The Tests tab’s Group by menu: the executions by failure cluster, the default on a red run, by file, by describe block, by lock, or not at all.',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/63?tab=test-cases', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-changes',
    kind: 'tab',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'changes' } }],
    describes:
      'The Changes tab: against one baseline run, the tests that started or stopped failing, got slower or faster, the commits and the environment changes.',
    shownWhen: 'Once the run has finished.',
    help: 'run.changes',
    doc: 'features/run-changes',
    sample: { route: '/test-runs/63?tab=changes', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-baseline-picker',
    kind: 'action',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'changes' } }],
    describes:
      'The Changes tab’s baseline picker: take the baseline from one base branch, compare with one earlier run, or with the run just before.',
    shownWhen: 'When the project has an earlier run to compare with.',
    doc: 'features/run-changes#picking-another-baseline',
    sample: { route: '/test-runs/63?tab=changes', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-workers',
    kind: 'tab',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'workers' } }],
    describes:
      'The Timeline tab: each worker’s tests on one time axis, then the slowest executions and how the tests spread across the workers.',
    doc: 'features/ui-overview#test-run-detail',
    sample: { route: '/test-runs/63?tab=workers', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-timeline',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'workers' } }],
    describes:
      'The Workers tab’s timeline: each worker’s tests in time, under the CPU, memory and open pages of the machine that ran them.',
    shownWhen: 'When the run’s tests reported when they started and on which worker.',
    help: 'run.timeline',
    doc: 'features/cpu-memory-disk',
    sample: { route: '/test-runs/63?tab=workers', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-resources',
    kind: 'tab',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'resources' } }],
    describes:
      'The Resources tab: what the run’s tests left open, what the run cost the machine it ran on, and the tests that used the most CPU.',
    shownWhen: 'When the reporter sent a resource report with the run.',
    requires: { capability: 'resources' },
    doc: 'features/resource-leaks#in-the-dashboard',
    sample: { route: '/test-runs/62?tab=resources', expect: { run: { id: 62, project: 'web-dashboard' } } },
  },
  {
    id: 'run-leaks',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'resources' } }],
    describes:
      'The Findings of the Resources tab: what the run’s tests left open past their scope, such as a browser context, with the line that opened it.',
    shownWhen: 'When the run’s resource report names a leak.',
    requires: { capability: 'resources' },
    help: 'run.resource-findings',
    doc: 'features/resource-leaks',
    sample: {
      route: '/test-runs/62?tab=resources',
      expect: { run: { id: 62, project: 'web-dashboard' }, resources: 'leaky' },
    },
  },
  {
    id: 'run-open-pages',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'resources' } }],
    describes:
      'The Open pages over time card, which draws each worker’s open pages on the timeline: a line that climbs test after test is a page left open.',
    shownWhen: 'When the reporter counted the pages each worker kept open.',
    requires: { capability: 'resources' },
    help: 'run.resource-pages',
    doc: 'features/resource-leaks#in-the-dashboard',
    sample: { route: '/test-runs/62?tab=resources', expect: { run: { id: 62, project: 'web-dashboard' } } },
  },
  {
    id: 'run-machine',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'resources' } }],
    describes:
      'The Machine card: how busy the CPUs were, CPU time by process, the time spent waiting for a CPU, peak memory and the disk the artifacts used.',
    shownWhen: 'When the reporter sampled the machine, one card per shard.',
    requires: { capability: 'resources' },
    help: 'run.resource-machine',
    doc: 'features/cpu-memory-disk#reading-it',
    sample: { route: '/test-runs/62?tab=resources', expect: { run: { id: 62, project: 'web-dashboard' } } },
  },
  {
    id: 'run-costliest-tests',
    kind: 'block',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'resources' } }],
    describes:
      'The Costliest tests card: the tests that used the most CPU in their worker and their browser processes, and the pages open when each started.',
    shownWhen: 'When the reporter measured the CPU of the run’s tests.',
    requires: { capability: 'resources' },
    help: 'run.resource-costliest',
    doc: 'features/cpu-memory-disk#in-the-dashboard',
    sample: { route: '/test-runs/62?tab=resources', expect: { run: { id: 62, project: 'web-dashboard' } } },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const RUNS_EXEMPTIONS = [
  {
    rule: 'help',
    key: 'run.live',
    reason:
      'The Tests tab’s live counter shows only while a run is still reporting, and the seed has no run in progress.',
  },
  {
    rule: 'help',
    key: 'run.shuffle',
    reason: 'The Order line shows only for a run Playwright ran with --shuffle, and the seed has no shuffled run.',
  },
  {
    rule: 'help',
    key: 'run.externalIdDuplicates',
    reason:
      'The Duplicate IDs line shows only when two tests of a run declare one external ID, and no seeded run has any.',
  },
];
