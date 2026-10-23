/**
 * The guide anchors of a failure cluster's page (`/failure-clusters/[id]`),
 * which a failed execution's page shows too.
 */

/** What the seed holds at the clusters the samples open. */
const USERS_TABLE_CLUSTER = { cluster: { id: 10, story: 'users-table-page-size' } };
const LOGIN_CLUSTER = { cluster: { id: 3, story: 'auth-login-500' } };
const MODAL_CLUSTER = { cluster: { id: 5, story: 'modal-never-opens' } };

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const CLUSTERS_ANCHORS = [
  {
    id: 'more-ways-to-fix',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The More ways to fix card: every other way to fix, verify or reproduce the failure, each section folded to one line.',
    help: 'fix.toolbox',
    doc: 'guide/first-failure#_6-more-ways-to-fix',
    sample: {
      route: '/failure-clusters/10',
      expect: { ...USERS_TABLE_CLUSTER, diagnosis: 'with-patch', fixLanded: true },
    },
  },
  {
    id: 'fix-section-diagnosis',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Diagnosis section of More ways to fix: the AI diagnosis of the failure and its suggested patch, or Diagnose with AI and the context to add.',
    shownWhen:
      'Folded to its line until opened, or open when the next step points at it, on a cluster as a card of its own.',
    doc: 'features/ai-diagnosis',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'fix-section-locator-fix',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Locator fix section of More ways to fix: the failing locator and the replacements locator healing ranks from the failing page.',
    shownWhen: 'When a locator broke and healing has a replacement.',
    requires: { capability: 'locator-healing' },
    doc: 'features/locator-healing',
    sample: {
      route: '/test-run-cases/533',
      expect: { execution: { id: 533, title: 'Button primary variant renders correctly' } },
    },
  },
  {
    id: 'fix-section-verify',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Verify section of More ways to fix: the command that re-runs the failing tests, Re-run in CI, and running them locally in the desktop app.',
    shownWhen: 'When the failure has a verify command, a CI re-run or the desktop app.',
    doc: 'guide/first-failure#_6-more-ways-to-fix',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'fix-section-reproduce',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Reproduce and bisect section of More ways to fix: the recipe that reproduces the failure locally, and the git bisect that finds its commit.',
    shownWhen: 'When the fix plan has the steps to reproduce the failure.',
    doc: 'features/fix-plans#reproduce-and-bisect',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'fix-section-fixed-before',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Fixed before section of More ways to fix: the resolved clusters this failure resembles, how each was fixed, and Apply the same triage.',
    shownWhen: 'When a resolved cluster of the project resembles this one closely enough.',
    doc: 'features/fix-plans#fixed-before',
    sample: { route: '/failure-clusters/9', expect: { cluster: { id: 9, story: 'dark-mode-export-hidden' } } },
  },
  {
    id: 'fix-section-blocked',
    kind: 'block',
    pages: ['/test-run-cases/[id]'],
    describes:
      'The Blocked by this failure section of More ways to fix: the later tests of its serial group that did not run because this one failed.',
    shownWhen: 'When the failure stopped later tests of a serial group from running.',
    doc: 'guide/first-failure#_6-more-ways-to-fix',
    sample: { route: '/test-run-cases/6', expect: { execution: { id: 6, title: 'should add item to cart' } } },
  },
  {
    id: 'fix-section-fix-plan',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Fix plan section of More ways to fix: the cluster’s plan, its diagnosis, edits and verify command, to copy as Markdown or open on the cluster.',
    shownWhen: 'On a cluster with a fix plan, and on an execution of a cluster.',
    doc: 'features/fix-plans',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'diagnosis-fix',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    reveal: [{ unfold: 'fix-section-diagnosis' }],
    describes:
      'The patch the cluster’s AI diagnosis suggests, checked against the source, with whether it applies cleanly and how to apply it.',
    shownWhen: 'When the cluster has an AI diagnosis that suggests a fix.',
    requires: { capability: 'ai' },
    doc: 'features/ai-diagnosis',
    sample: {
      route: '/failure-clusters/10',
      expect: { ...USERS_TABLE_CLUSTER, diagnosis: 'with-patch', fixLanded: true },
    },
  },
  {
    id: 'issue-line',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Issue line: the ticket the cluster is tracked in with its status, or Create issue and Link an issue when it has none.',
    shownWhen: 'When the cluster is tracked, or is open and the viewer can create or link an issue.',
    requires: { capability: 'integrations' },
    doc: 'features/issue-tracking',
    sample: {
      route: '/failure-clusters/3',
      expect: { ...LOGIN_CLUSTER, issue: { key: 'DEMO-42', status: 'In Progress' } },
    },
  },
  {
    id: 'cluster-heading',
    kind: 'page',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The heading line of a failure cluster’s page: its number, its error type, its project and the owner of its tests.',
    doc: 'features/failure-clusters#the-cluster-page',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'cluster-state',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The State line: where the cluster stands in one sentence, still failing or fixed and verified, with the action that reconciles it and Triage.',
    help: 'cluster.state',
    doc: 'features/failure-clusters#the-state-line',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'what-changed-line',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The What changed line: the commits since the last passing run in one clause, the suspect lines the failing tests ran, and the way to the diff.',
    help: 'cluster.suspect-lines-coverage',
    doc: 'features/ai-diagnosis#scm-grounded-context',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'what-changed-card',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The What changed card: the baseline commit, the suspect lines, then the commits and diffs since the last passing run, to find the breaking change.',
    shownWhen: 'When the runs name a repository and the host returns the commits of the range.',
    requires: { capability: 'scm' },
    help: 'cluster.scm',
    doc: 'features/ai-diagnosis#scm-grounded-context',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'what-changed-baseline',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The Baseline row of the What changed card: the last known-good commit the diffs start from, which you can change and pin for the cluster.',
    shownWhen: 'When the runs name a repository and the host returns the commits of the range.',
    requires: { capability: 'scm' },
    help: 'cluster.baseline',
    doc: 'features/ai-diagnosis#scm-grounded-context',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'suspect-lines',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The Suspect lines: the changed lines the failing tests ran, read from their coverage, the hunks the fewest passing tests ran first.',
    shownWhen: 'When the failing tests recorded coverage of the changed files.',
    requires: { capability: 'coverage' },
    help: 'cluster.suspect-lines',
    doc: 'guide/concepts#suspect-lines',
    sample: {
      route: '/failure-clusters/10',
      expect: { ...USERS_TABLE_CLUSTER, suspects: { path: 'api/Users/UsersEndpoints.cs', granularity: 'lines' } },
    },
  },
  {
    id: 'what-changed-browse',
    kind: 'action',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The What changed card’s Browse button, which opens the commit browser on the repository’s recent commits.',
    shownWhen: 'When the runs name a repository and the host returns the commits of the range.',
    requires: { capability: 'scm' },
    doc: 'features/ai-diagnosis#scm-grounded-context',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'commit-browser',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    reveal: [{ open: 'what-changed-browse' }],
    describes:
      'The commit browser: the repository’s recent commits, each with its diff, to choose the commits the diagnosis reads or find the suspect change.',
    shownWhen: 'When the runs name a repository and the host returns the commits of the range.',
    requires: { capability: 'scm' },
    help: 'cluster.commit-browser',
    doc: 'features/ai-diagnosis#scm-grounded-context',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'cluster-occurrence-trend',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The Occurrences over time chart, folded to its header: how often the failure cause failed and how many tests, with the moment its fix landed.',
    help: 'cluster.occurrence-trend',
    doc: 'features/failure-clusters#occurrences-over-time',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'cluster-more-actions',
    kind: 'action',
    pages: ['/failure-clusters/[id]'],
    describes:
      'The More actions menu of a cluster: its issue, quarantining its tests, Copy summary, the diagnosis context and the prompt for an AI agent.',
    doc: 'features/failure-clusters#the-cluster-page',
    sample: { route: '/failure-clusters/10', expect: USERS_TABLE_CLUSTER },
  },
  {
    id: 'cluster-details',
    kind: 'action',
    pages: ['/failure-clusters/[id]'],
    describes: 'The Details button of the cluster’s facts line, which opens its owner and every link pinned to it.',
    doc: 'features/failure-clusters#owners-and-assignees',
    sample: { route: '/failure-clusters/3', expect: LOGIN_CLUSTER },
  },
  {
    id: 'cluster-owner',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    reveal: [{ open: 'cluster-details' }],
    describes:
      'Who answers for the cluster’s tests, from a piwi:owner annotation or the repository’s CODEOWNERS, linked to every test of that owner.',
    help: 'cluster.owner',
    doc: 'features/failure-clusters#owners-and-assignees',
    sample: { route: '/failure-clusters/3', expect: LOGIN_CLUSTER },
  },
  {
    id: 'cluster-links',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    reveal: [{ open: 'cluster-details' }],
    describes:
      'Every link pinned to the cluster, its newest tracker issue first as the known issue that travels with it, also listed on its executions.',
    help: 'cluster.known-issue',
    doc: 'features/issue-tracking#the-key-travels',
    sample: {
      route: '/failure-clusters/3',
      expect: { ...LOGIN_CLUSTER, issue: { key: 'DEMO-42', status: 'In Progress' } },
    },
  },
  {
    id: 'diagnosis-result',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    reveal: [{ unfold: 'fix-section-diagnosis' }],
    describes:
      'The completed AI diagnosis: its category and confidence, the root cause, the evidence it cites, the suggested fix and how to confirm it.',
    shownWhen: 'When the cluster has a completed AI diagnosis.',
    requires: { capability: 'ai' },
    help: 'cluster.result',
    doc: 'features/ai-diagnosis#what-a-diagnosis-contains',
    sample: { route: '/failure-clusters/3', expect: { ...LOGIN_CLUSTER, diagnosis: 'with-patch' } },
  },
  {
    id: 'diagnosis-additional-context',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    reveal: [{ unfold: 'fix-section-diagnosis' }],
    describes:
      'The diagnosis’s Additional context: notes, text files and screenshots you add to steer the model with what the evidence cannot show.',
    shownWhen: 'When AI is configured.',
    requires: { capability: 'ai' },
    help: 'cluster.context-input',
    doc: 'features/ai-diagnosis#custom-instructions',
    sample: { route: '/failure-clusters/3', expect: LOGIN_CLUSTER },
  },
  {
    id: 'diagnosis-context-strip',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    reveal: [{ unfold: 'fix-section-diagnosis' }],
    describes:
      'The diagnosis’s Context strip: the evidence sections the model receives, the truncated ones marked, and the tokens they cost.',
    shownWhen: 'When AI is configured.',
    requires: { capability: 'ai' },
    help: 'cluster.coverage',
    doc: 'guide/ai-provider#context-limits-and-token-cost',
    sample: { route: '/failure-clusters/3', expect: LOGIN_CLUSTER },
  },
  {
    id: 'diagnosis-show-context',
    kind: 'action',
    pages: ['/failure-clusters/[id]'],
    reveal: [{ open: 'cluster-more-actions' }],
    describes:
      'The More actions menu’s Show context, which opens exactly what the cluster’s diagnosis sends to the model.',
    shownWhen: 'When AI is configured.',
    requires: { capability: 'ai' },
    doc: 'guide/ai-provider#context-limits-and-token-cost',
    sample: { route: '/failure-clusters/3', expect: LOGIN_CLUSTER },
  },
  {
    id: 'diagnosis-context',
    kind: 'block',
    pages: ['/failure-clusters/[id]'],
    reveal: [{ open: 'cluster-more-actions' }, { open: 'diagnosis-show-context' }],
    describes:
      'The Context sent to AI dialog: every evidence section the diagnosis sends, its data coverage map and the token estimate, before you spend tokens.',
    shownWhen: 'When AI is configured.',
    requires: { capability: 'ai' },
    help: 'cluster.context-preview',
    doc: 'guide/ai-provider#context-limits-and-token-cost',
    sample: { route: '/failure-clusters/3', expect: LOGIN_CLUSTER },
  },
  {
    id: 'diagnose-with-ai',
    kind: 'action',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    reveal: [{ unfold: 'fix-section-diagnosis' }],
    describes:
      'The Diagnose with AI button, which streams a diagnosis of the failure from its evidence, its source changes and the context you added.',
    shownWhen: 'When AI is configured and the failure has no completed diagnosis.',
    requires: { capability: 'ai', permission: 'ai:run' },
    doc: 'features/ai-diagnosis#what-a-diagnosis-contains',
    sample: { route: '/failure-clusters/5', expect: { ...MODAL_CLUSTER, diagnosis: 'none' } },
  },
  {
    id: 'create-issue',
    kind: 'action',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Issue line’s Create issue button, which files a Jira issue from the failure with its fix plan as the body.',
    shownWhen: 'When a tracker is connected and the open cluster has no issue.',
    requires: { capability: 'integrations', permission: 'issue:create' },
    doc: 'features/issue-tracking#what-it-does-exactly',
    sample: { route: '/failure-clusters/5', expect: MODAL_CLUSTER },
  },
  {
    id: 'link-issue',
    kind: 'action',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Issue line’s Link an issue button, which pins an issue already filed to the cluster as its known issue.',
    shownWhen: 'When the open cluster has no issue.',
    requires: { permission: 'link:write' },
    doc: 'features/issue-tracking#the-key-travels',
    sample: { route: '/failure-clusters/5', expect: MODAL_CLUSTER },
  },
  {
    id: 'create-issue-draft',
    kind: 'block',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    reveal: [{ open: 'create-issue' }],
    describes:
      'The Create issue dialog’s draft: the summary, description and fields of the Jira issue to file, or the issue that already tracks the failure.',
    shownWhen: 'When a tracker is connected and the cluster has no issue.',
    requires: { capability: 'integrations', permission: 'issue:create' },
    help: 'integrations.create-issue',
    doc: 'features/issue-tracking#what-it-does-exactly',
    sample: { route: '/failure-clusters/5', expect: MODAL_CLUSTER },
  },
  {
    id: 'quarantine-all-tests',
    kind: 'action',
    pages: ['/failure-clusters/[id]'],
    reveal: [{ open: 'cluster-more-actions' }],
    describes:
      'The More actions menu’s Quarantine all affected tests: each test of the cluster keeps running, but no longer counts in the CI gate’s verdict.',
    shownWhen: 'When the viewer can quarantine the project’s tests and a test of the cluster is not quarantined.',
    requires: { capability: 'quarantine', permission: 'quarantine:write' },
    doc: 'features/flaky-tests#quarantine-with-a-way-out',
    sample: { route: '/failure-clusters/5', expect: MODAL_CLUSTER },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const CLUSTERS_EXEMPTIONS = [
  {
    rule: 'help',
    key: 'cluster.activity',
    reason:
      'The Activity card shows once a fix attempt, an agent’s write or a write to the tracker is recorded, and the seed records none.',
  },
  {
    rule: 'help',
    key: 'cluster.ai-setup',
    reason: 'The AI not configured line shows only without an AI provider, and the demo always runs its simulated one.',
  },
];
