/**
 * The live question set: what people ask the assistant about the demo seed,
 * each question with what a good answer holds. `assistant-live.spec.ts` asks
 * every one in a fresh conversation against a real model and scores the
 * answer; `tests/unit/assistant-questions.test.ts` checks the set itself with
 * no model.
 *
 * The questions by topic:
 *
 *   failure  30  why a failure happened: a cluster, an execution, its fix
 *   flaky    20  which tests are flaky, why, and what to do about them
 *   run      18  what changed in a run, what failed and what it left behind
 *   setting  20  where a setting is and what it does, with a guide to it
 *   setup    25  how to set something up: CI, sharding, SCM token, AI, notifications, Jira, roles
 *   piwi     15  what Piwi is and does
 *   show-me  22  a guide on the screens: where something is, how to do it
 *
 * Each question carries:
 *
 * - `on`: the route it is asked on, when it is asked on a page; the panel's
 *   page context is built from it (`questionContext`), as the panel builds it.
 * - `tools`: a good answer calls at least one of them without an error.
 * - `facts`: each fact is something the answer must say, as one of its
 *   alternatives, taken from where the ground truth is: `story:<key>` a
 *   failure story, `example:<id>` a demo example, `project:<id>` a demo
 *   project, `seed:<table>` a table of the generated seed, `docs:<page>` a
 *   bundled docs page and `env:<name>` a `PIWI_*` variable of the registry. A
 *   string alternative matches case-insensitively; a pattern is matched as
 *   written. Both are matched on the text as `normalizeFactText` writes it,
 *   and both must match their source too, so a fact never says what the seed
 *   or the docs do not.
 * - `blocks`: when a block fits the question, the kinds of which the answer
 *   uses at least one: a question with checkboxes for "which tests should I
 *   quarantine", a checklist for a setup, a guide for "where is…".
 * - `anchors`: for a guide, the registry anchors of which it stops on at
 *   least one.
 */
import type { AssistantBlock, AssistantPageContext } from '#shared/assistant';
import { assistantPageContext } from '../../app/utils/assistant/page-context';

export const QUESTION_TOPICS = ['failure', 'flaky', 'run', 'setting', 'setup', 'piwi', 'show-me'] as const;

export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

/** How many questions each topic has, as the header lists them. */
export const QUESTION_SPREAD: Readonly<Record<QuestionTopic, number>> = {
  failure: 30,
  flaky: 20,
  run: 18,
  setting: 20,
  setup: 25,
  piwi: 15,
  'show-me': 22,
};

/** The block kinds an answer can be expected to use: every kind but text. */
export const EXPECTED_BLOCK_KINDS = [
  'code',
  'command',
  'patch',
  'entity',
  'options',
  'question',
  'checklist',
  'guide',
  'navigate',
] as const satisfies readonly Exclude<AssistantBlock['kind'], 'text'>[];

export type ExpectedBlockKind = (typeof EXPECTED_BLOCK_KINDS)[number];

export type FactSource =
  | `story:${string}`
  | `example:${string}`
  | `project:${number}`
  | `seed:${string}`
  | `docs:${string}`
  | `env:${string}`;

export interface QuestionFact {
  from: FactSource;
  /** The answer says one of these. */
  any: readonly (string | RegExp)[];
}

export interface LiveQuestion {
  /** Kebab-case, unique. */
  id: string;
  topic: QuestionTopic;
  question: string;
  /** The route of the seeded app the question is asked on. */
  on?: string;
  tools: readonly string[];
  facts: readonly QuestionFact[];
  blocks?: readonly ExpectedBlockKind[];
  anchors?: readonly string[];
}

const fact =
  (kind: string) =>
  (name: string | number, ...any: (string | RegExp)[]): QuestionFact => ({
    from: `${kind}:${name}` as FactSource,
    any,
  });

const story = fact('story');
const example = fact('example');
const project = fact('project');
const seed = fact('seed');
const docs = fact('docs');
const env = fact('env');

const CLUSTER_TOOLS = ['get_cluster', 'get_cluster_context', 'get_cluster_diagnosis', 'get_fix_plan'];
const EXECUTION_TOOLS = ['explain_failure', 'get_test_run_case', 'get_test_case_context', 'get_execution_diagnosis'];
const GUIDE_TOOLS = ['find_anchors'];
const SETTING_TOOLS = ['find_anchors', 'describe_piwi', 'get_instance_config'];
const DOCS_TOOLS = ['describe_piwi'];

const failure: LiveQuestion[] = [
  {
    id: 'cluster-pay-why',
    topic: 'failure',
    question: 'Why does this failure keep happening?',
    on: '/failure-clusters/1',
    tools: CLUSTER_TOOLS,
    facts: [story('checkout-pay-timeout', 'quote'), story('checkout-pay-timeout', 'disabled')],
  },
  {
    id: 'execution-pay-why',
    topic: 'failure',
    question: 'Why did this test fail?',
    on: '/test-run-cases/37',
    tools: EXECUTION_TOOLS,
    facts: [story('checkout-pay-timeout', /time ?out|timed out/i), story('checkout-pay-timeout', /\bPay\b/)],
  },
  {
    id: 'cluster-login-why',
    topic: 'failure',
    question: 'What is causing these login failures?',
    on: '/failure-clusters/3',
    tools: CLUSTER_TOOLS,
    facts: [story('auth-login-500', '500'), story('auth-login-500', /null/i)],
  },
  {
    id: 'cluster-users-why',
    topic: 'failure',
    question: 'Why does the users table test fail?',
    on: '/failure-clusters/10',
    tools: CLUSTER_TOOLS,
    facts: [story('users-table-page-size', /page size/i), example('ai-diagnosis-stored', /\b50\b/)],
  },
  {
    id: 'cluster-users-fixed',
    topic: 'failure',
    question: 'Has the fix for this failure landed?',
    on: '/failure-clusters/10',
    tools: ['get_cluster', 'get_fix_plan', 'get_cluster_context'],
    facts: [example('ai-diagnosis-stored', /landed/i)],
  },
  {
    id: 'cluster-email-locator',
    topic: 'failure',
    question: 'Which locator broke here, and what should it be now?',
    on: '/failure-clusters/2',
    tools: ['get_cluster', 'get_fix_plan', 'get_cluster_context', 'get_locator_healing'],
    facts: [story('checkout-email-renamed', 'Email address'), seed('locator_snapshots', 'email-field')],
  },
  {
    id: 'execution-email-healing',
    topic: 'failure',
    question: 'What locator should replace the one that failed?',
    on: '/test-run-cases/87',
    tools: ['get_locator_healing', 'explain_failure'],
    facts: [seed('locator_snapshots', 'email-field')],
  },
  {
    id: 'cluster-modal-why',
    topic: 'failure',
    question: 'Why does the modal never open?',
    on: '/failure-clusters/5',
    tools: CLUSTER_TOOLS,
    facts: [story('modal-never-opens', 'activate'), story('modal-never-opens', /focus trap/i)],
  },
  {
    id: 'cluster-button-strict',
    topic: 'failure',
    question: 'What is this strict mode violation about?',
    on: '/failure-clusters/6',
    tools: CLUSTER_TOOLS,
    facts: [story('button-strict-mode', "getByRole('button')"), story('button-strict-mode', /3 elements|three/i)],
  },
  {
    id: 'cluster-mobile-goto',
    topic: 'failure',
    question: 'Why do the mobile navigation tests time out?',
    on: '/failure-clusters/7',
    tools: CLUSTER_TOOLS,
    facts: [story('mobile-goto-timeout', /hero/i), story('mobile-goto-timeout', 'page.goto')],
  },
  {
    id: 'cluster-webkit-crash',
    topic: 'failure',
    question: 'Why does the browser close in the middle of this test?',
    on: '/failure-clusters/8',
    tools: CLUSTER_TOOLS,
    facts: [story('mobile-webkit-crash', /signature/i), story('mobile-webkit-crash', 'WebKit')],
  },
  {
    id: 'cluster-export-hidden',
    topic: 'failure',
    question: 'Why is the Export CSV button not visible?',
    on: '/failure-clusters/9',
    tools: CLUSTER_TOOLS,
    facts: [story('dark-mode-export-hidden', /dark mode/i), story('dark-mode-export-hidden', 'theme.css')],
  },
  {
    id: 'cluster-date-picker',
    topic: 'failure',
    question: 'What broke the date picker test?',
    on: '/failure-clusters/11',
    tools: CLUSTER_TOOLS,
    facts: [
      story('mobile-delivery-date-relabeled', 'Date of delivery'),
      story('mobile-delivery-date-relabeled', 'Delivery date'),
    ],
  },
  {
    id: 'cluster-order-status',
    topic: 'failure',
    question: 'Why does the order status update fail?',
    on: '/failure-clusters/4',
    tools: CLUSTER_TOOLS,
    facts: [story('orders-status-transition', 'payment_pending'), story('orders-status-transition', 'confirmed')],
  },
  {
    id: 'execution-auth-me',
    topic: 'failure',
    question: 'Why did GET /auth/me fail in this run?',
    on: '/test-run-cases/299',
    tools: EXECUTION_TOOLS,
    facts: [story('auth-login-500', '500')],
  },
  {
    id: 'execution-email-what',
    topic: 'failure',
    question: 'What went wrong in this execution?',
    on: '/test-run-cases/87',
    tools: EXECUTION_TOOLS,
    facts: [story('checkout-email-renamed', 'Email address'), story('checkout-email-renamed', /fill/i)],
  },
  {
    id: 'execution-modal-console',
    topic: 'failure',
    question: 'Is there a console error behind this failure?',
    on: '/test-run-cases/587',
    tools: EXECUTION_TOOLS,
    facts: [story('modal-never-opens', 'TypeError'), story('modal-never-opens', 'activate')],
  },
  {
    id: 'execution-mobile-blame',
    topic: 'failure',
    question: 'Is this a problem in the test or in the app?',
    on: '/test-run-cases/658',
    tools: EXECUTION_TOOLS,
    facts: [story('mobile-goto-timeout', /hero/i)],
  },
  {
    id: 'execution-export-dark',
    topic: 'failure',
    question: 'Which browser setting makes this test fail?',
    on: '/test-run-cases/715',
    tools: EXECUTION_TOOLS,
    facts: [story('dark-mode-export-hidden', /dark/i)],
  },
  {
    id: 'execution-server-coverage',
    topic: 'failure',
    question: 'Which server code did this test run?',
    on: '/test-run-cases/711?evidence=source',
    tools: ['explain_failure', 'get_test_case_context', 'get_coverage', 'compare_coverage'],
    facts: [example('suspect-lines-server', 'UsersEndpoints.cs')],
  },
  {
    id: 'login-500-no-page',
    topic: 'failure',
    question: 'Why does POST /auth/login return 500 in the api-integration project?',
    tools: ['search', 'list_open_clusters', 'get_cluster', 'get_fix_plan', 'list_projects'],
    facts: [story('auth-login-500', /null/i), seed('failure_diagnoses', 'verifyCredentials')],
  },
  {
    id: 'most-occurrences',
    topic: 'failure',
    question: 'Which open failure cluster has the most occurrences?',
    tools: ['list_open_clusters', 'search'],
    facts: [story('modal-never-opens', /modal/i)],
  },
  {
    id: 'cluster-login-ticket',
    topic: 'failure',
    question: 'Is this failure tracked in Jira?',
    on: '/failure-clusters/3',
    tools: ['get_cluster', 'list_links', 'get_fix_plan'],
    facts: [example('issue-tracked-cluster', 'DEMO-42'), example('issue-tracked-cluster', 'In Progress')],
  },
  {
    id: 'cluster-pay-held',
    topic: 'failure',
    question: 'Did the fix for this failure hold?',
    on: '/failure-clusters/1',
    tools: ['get_cluster', 'get_fix_plan', 'get_cluster_context'],
    facts: [seed('failure_clusters', /did not hold|regressed|reopened/i)],
  },
  {
    id: 'cluster-pay-fix',
    topic: 'failure',
    question: 'How do I fix this?',
    on: '/failure-clusters/1',
    tools: ['get_fix_plan', 'get_cluster_diagnosis', 'get_cluster'],
    facts: [story('checkout-pay-timeout', 'payment.ts'), story('checkout-pay-timeout', 'quote')],
    blocks: ['patch', 'options'],
  },
  {
    id: 'cluster-users-patch',
    topic: 'failure',
    question: 'Can you show me the patch that fixes this?',
    on: '/failure-clusters/10',
    tools: ['get_fix_plan', 'get_cluster_diagnosis'],
    facts: [story('users-table-page-size', 'UsersEndpoints.cs')],
    blocks: ['patch'],
  },
  {
    id: 'cluster-modal-culprit',
    topic: 'failure',
    question: 'Which change is the likely culprit?',
    on: '/failure-clusters/5',
    tools: ['get_cluster_context', 'get_fix_plan', 'get_repo_commits', 'get_repo_diff'],
    facts: [example('suspect-lines-cluster', 'modal-controller')],
  },
  {
    id: 'execution-retry-attempt',
    topic: 'failure',
    question: 'This passed on retry. What failed on the first attempt?',
    on: '/test-run-cases/768',
    tools: EXECUTION_TOOLS,
    facts: [seed('test_runs_cases', 'data-theme'), seed('test_runs_cases', /light/i)],
  },
  {
    id: 'execution-did-not-run',
    topic: 'failure',
    question: "Why didn't this test run?",
    on: '/test-run-cases/748',
    tools: ['get_test_run_case', 'explain_failure', 'get_run'],
    facts: [seed('test_runs_cases', /max.?failures/i)],
  },
  {
    id: 'cluster-email-diagnosis',
    topic: 'failure',
    question: 'Is there an AI diagnosis for this cluster yet?',
    on: '/failure-clusters/2',
    tools: ['get_cluster_diagnosis', 'get_cluster'],
    facts: [example('ai-diagnosis-simulated', /no (stored )?diagnosis/i)],
  },
];

const flaky: LiveQuestion[] = [
  {
    id: 'project-checkout-flaky',
    topic: 'flaky',
    question: 'Which tests in this project are flaky?',
    on: '/projects/1',
    tools: ['list_flaky_tests', 'get_spec_health'],
    facts: [example('flake-lab-reproduced', 'should apply discount code')],
  },
  {
    id: 'checkout-quarantine-pick',
    topic: 'flaky',
    question: 'Which flaky tests should I quarantine?',
    on: '/projects/1?tab=flaky-tests',
    tools: ['list_flaky_tests'],
    facts: [example('flake-lab-reproduced', 'should apply discount code')],
    blocks: ['question'],
  },
  {
    id: 'project-ui-flaky',
    topic: 'flaky',
    question: 'Which tests flake in this project?',
    on: '/projects/3',
    tools: ['list_flaky_tests', 'get_spec_health'],
    facts: [story('modal-never-opens', 'Modal opens and closes correctly')],
  },
  {
    id: 'project-mobile-flaky',
    topic: 'flaky',
    question: 'Is any test in this project flaky?',
    on: '/projects/4',
    tools: ['list_flaky_tests', 'get_spec_health'],
    facts: [story('mobile-webkit-crash', 'Text input shows keyboard on focus')],
  },
  {
    id: 'dark-mode-why-flaky',
    topic: 'flaky',
    question: 'Why is this test flaky?',
    on: '/test-cases/53',
    tools: ['get_flake_profile', 'get_test_case', 'get_test_case_context', 'get_test_stability_trend'],
    facts: [
      example('path-variation-order', 'updates the organization name'),
      example('path-variation-order', /order/i),
    ],
  },
  {
    id: 'discount-what-flakes',
    topic: 'flaky',
    question: 'What makes this test flaky?',
    on: '/test-cases/9',
    tools: ['get_flake_profile', 'get_test_case', 'plan_flake_experiment'],
    facts: [example('flake-lab-reproduced', /cart/i)],
  },
  {
    id: 'table-release',
    topic: 'flaky',
    question: 'Can this test leave quarantine?',
    on: '/test-cases/35',
    tools: ['get_test_case', 'get_flake_profile', 'plan_flake_experiment'],
    facts: [example('flake-lab-verified-fix', /verified/i)],
  },
  {
    id: 'discount-reproduce',
    topic: 'flaky',
    question: 'How do I reproduce this flake on my machine?',
    on: '/test-cases/9?tab=flakiness',
    tools: ['plan_flake_experiment', 'get_flake_profile'],
    facts: [docs('features/flake-lab', 'npx @piwitests/reporter flake')],
    blocks: ['command'],
  },
  {
    id: 'flaky-score',
    topic: 'flaky',
    question: 'How does Piwi score how flaky a test is?',
    tools: DOCS_TOOLS,
    facts: [docs('features/flaky-tests', /retr(y|ies)/i), docs('features/flaky-tests', /alternat|flip/i)],
  },
  {
    id: 'quarantine-effect',
    topic: 'flaky',
    question: 'What happens to a test I quarantine?',
    tools: DOCS_TOOLS,
    facts: [docs('features/flaky-tests', /keeps running/i), docs('features/flaky-tests', /gate/i)],
  },
  {
    id: 'quarantine-release-when',
    topic: 'flaky',
    question: 'When is a quarantined test ready to be released?',
    tools: DOCS_TOOLS,
    facts: [docs('features/flaky-tests', /(five|5) consecutive pass/i)],
  },
  {
    id: 'flaky-categories',
    topic: 'flaky',
    question: 'What root-cause categories can a flaky test get?',
    tools: DOCS_TOOLS,
    facts: [
      docs('features/flaky-tests', 'timing'),
      docs('features/flaky-tests', 'network'),
      docs('features/flaky-tests', 'order'),
    ],
  },
  {
    id: 'discount-suspects',
    topic: 'flaky',
    question: 'What are the suspects for this flake?',
    on: '/test-cases/9?tab=flakiness',
    tools: ['get_flake_profile'],
    facts: [seed('network_requests', '/api/cart')],
  },
  {
    id: 'table-fix-attempts',
    topic: 'flaky',
    question: 'How many fix attempts did this flake take?',
    on: '/test-cases/35?tab=flakiness',
    tools: ['get_test_case', 'get_flake_profile', 'plan_flake_experiment'],
    facts: [example('flake-lab-verified-fix', /second|two|2/i)],
  },
  {
    id: 'retry-flaky-or-regression',
    topic: 'flaky',
    question: 'Is this flaky, or a real regression?',
    on: '/test-run-cases/768',
    tools: ['explain_failure', 'get_test_run_case', 'get_test_case'],
    facts: [example('path-variation-order', 'updates the organization name')],
  },
  {
    id: 'dark-mode-fix-options',
    topic: 'flaky',
    question: 'How should I fix this flaky test?',
    on: '/test-cases/53',
    tools: ['get_flake_profile', 'get_test_case', 'plan_flake_experiment'],
    facts: [example('path-variation-order', 'updates the organization name')],
    blocks: ['options'],
  },
  {
    id: 'dark-mode-quarantine',
    topic: 'flaky',
    question: 'Should I quarantine this test or fix it?',
    on: '/test-cases/53',
    tools: ['get_flake_profile', 'get_test_case'],
    facts: [example('path-variation-order', /order/i)],
    blocks: ['options', 'question'],
  },
  {
    id: 'gate-quarantine',
    topic: 'flaky',
    question: 'Will a quarantined test still fail my CI gate?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ci', '--max-quarantined'), docs('guide/ci', /does not count|excluded/i)],
  },
  {
    id: 'flake-lab-what',
    topic: 'flaky',
    question: 'What does the Flake Lab do?',
    tools: DOCS_TOOLS,
    facts: [docs('features/flake-lab', /control/i), docs('features/flake-lab', /suspect/i)],
  },
  {
    id: 'flake-lab-ci',
    topic: 'flaky',
    question: 'Can I run the Flake Lab in CI?',
    tools: DOCS_TOOLS,
    facts: [docs('features/flake-lab', 'flake verify')],
  },
];

const run: LiveQuestion[] = [
  {
    id: 'run-checkout-changes',
    topic: 'run',
    question: 'What changed in this run compared to the last good one?',
    on: '/test-runs/2',
    tools: ['get_run_insights', 'get_run'],
    facts: [story('checkout-pay-timeout', /credit card/i), story('checkout-email-renamed', 'Apple Pay')],
  },
  {
    id: 'run-incident',
    topic: 'run',
    question: 'Why did almost every test fail in this run?',
    on: '/test-runs/14',
    tools: ['get_run', 'get_run_insights', 'get_failure_groups'],
    facts: [example('environment-incident-run', 'staging'), example('environment-incident-run', /incident/i)],
  },
  {
    id: 'run-leaks',
    topic: 'run',
    question: "What do this run's tests leave open?",
    on: '/test-runs/62?tab=resources',
    tools: ['get_resource_profile', 'get_run', 'list_resource_findings'],
    facts: [example('resources-leaky-run', /login fixture/i), example('resources-leaky-run', /context/i)],
  },
  {
    id: 'run-coverage-gap',
    topic: 'run',
    question: "Why is this run's coverage incomplete?",
    on: '/test-runs/63',
    tools: ['get_run', 'get_coverage_summary'],
    facts: [example('run-coverage-incomplete', /restart/i)],
  },
  {
    id: 'run-did-not-run',
    topic: 'run',
    question: 'Why did some tests not run in this run?',
    on: '/test-runs/1',
    tools: ['get_run', 'get_failure_groups', 'list_failed_cases'],
    facts: [project(1, 'should add item to cart'), project(1, /serial/i)],
  },
  {
    id: 'run-api-summary',
    topic: 'run',
    question: 'Summarize this run.',
    on: '/test-runs/21',
    tools: ['get_run', 'get_run_insights', 'get_failure_groups'],
    facts: [story('auth-login-500', '/auth/login'), story('orders-status-transition', '/orders/:id/status')],
  },
  {
    id: 'run-checkout-groups',
    topic: 'run',
    question: "Group this run's failures by cause.",
    on: '/test-runs/2',
    tools: ['get_failure_groups', 'get_run'],
    facts: [story('checkout-pay-timeout', /\bPay\b/), story('checkout-email-renamed', 'Email address')],
  },
  {
    id: 'latest-checkout-run',
    topic: 'run',
    question: 'How did the latest e2e-checkout run go?',
    tools: ['list_runs', 'get_project', 'get_run', 'list_projects'],
    facts: [seed('test_runs', 'v2.4.0'), story('checkout-pay-timeout', /credit card|PayPal/i)],
  },
  {
    id: 'run-ui-new',
    topic: 'run',
    question: 'Which failures in this run are new?',
    on: '/test-runs/39',
    tools: ['get_run_insights', 'get_run'],
    facts: [story('modal-never-opens', /modal/i)],
  },
  {
    id: 'run-mobile-failed',
    topic: 'run',
    question: 'What failed in this run?',
    on: '/test-runs/54',
    tools: ['get_run', 'get_failure_groups', 'list_failed_cases'],
    facts: [
      story('mobile-goto-timeout', /tab bar|back gesture/i),
      story('mobile-webkit-crash', /keyboard/i),
      story('mobile-delivery-date-relabeled', /date picker/i),
    ],
  },
  {
    id: 'run-interrupted',
    topic: 'run',
    question: 'Why was this run interrupted?',
    on: '/test-runs/66',
    tools: ['get_run', 'get_failure_groups'],
    facts: [seed('test_runs_cases', /max.?failures/i)],
  },
  {
    id: 'run-memory',
    topic: 'run',
    question: 'Why does memory climb during this run?',
    on: '/test-runs/62?tab=workers',
    tools: ['get_resource_profile', 'get_run'],
    facts: [example('resources-leaky-timeline', /login fixture/i)],
  },
  {
    id: 'run-changes-baseline',
    topic: 'run',
    question: 'What does the Changes tab compare this run against?',
    on: '/test-runs/1?tab=changes',
    tools: ['get_run_insights', 'describe_piwi'],
    facts: [docs('features/run-changes', /baseline/i)],
  },
  {
    id: 'run-retry-passes',
    topic: 'run',
    question: 'Which tests passed only on retry in this run?',
    on: '/test-runs/2',
    tools: ['get_run', 'get_run_insights'],
    facts: [example('flake-lab-reproduced', 'should apply discount code')],
  },
  {
    id: 'run-incident-counted',
    topic: 'run',
    question: 'Does this run count against our pass rate?',
    on: '/test-runs/14',
    tools: ['get_run', 'describe_piwi'],
    facts: [example('environment-incident-run', /not counted/i)],
  },
  {
    id: 'project-web-latest',
    topic: 'run',
    question: "What's the state of this project's latest run?",
    on: '/projects/5',
    tools: ['get_project', 'list_runs', 'get_run'],
    facts: [story('dark-mode-export-hidden', /export/i)],
  },
  {
    id: 'run-web-known',
    topic: 'run',
    question: 'Which test failed here, and is it a known problem?',
    on: '/test-runs/62',
    tools: ['get_run', 'get_failure_groups', 'get_cluster'],
    facts: [story('dark-mode-export-hidden', 'Export CSV'), story('dark-mode-export-hidden', /dark mode/i)],
  },
  {
    id: 'recent-activity',
    topic: 'run',
    question: 'What happened in the latest runs across all projects?',
    on: '/',
    tools: ['list_recent_activity', 'list_projects'],
    facts: [seed('projects', 'web-dashboard'), seed('projects', 'api-integration')],
  },
];

const setting: LiveQuestion[] = [
  {
    id: 'scm-token-project',
    topic: 'setting',
    question: 'Where do I set the SCM token for one project?',
    tools: SETTING_TOOLS,
    facts: [docs('guide/source-control', 'Source control')],
    blocks: ['guide'],
    anchors: ['project-scm-token', 'project-settings-source-control'],
  },
  {
    id: 'scm-token-instance',
    topic: 'setting',
    question: 'Where is the repository token every project uses?',
    tools: SETTING_TOOLS,
    facts: [docs('guide/source-control', 'Repository access')],
    blocks: ['guide'],
    anchors: ['ai-repository-access'],
  },
  {
    id: 'auto-diagnose',
    topic: 'setting',
    question: 'What does Auto-diagnose do, and where do I turn it on?',
    tools: SETTING_TOOLS,
    facts: [docs('guide/ai-provider', 'Auto-diagnose'), docs('guide/ai-provider', /when a run finishes/i)],
    blocks: ['guide'],
    anchors: ['ai-auto-diagnose'],
  },
  {
    id: 'retention',
    topic: 'setting',
    question: 'Where do I set how long runs are kept?',
    tools: SETTING_TOOLS,
    facts: [docs('operate/storage', 'PIWI_RETENTION_DAYS')],
    blocks: ['guide'],
    anchors: ['storage-cleanup', 'storage-page'],
  },
  {
    id: 'api-key-where',
    topic: 'setting',
    question: 'Where do I create an API key?',
    tools: SETTING_TOOLS,
    facts: [docs('operate/api-keys', 'Settings → Account'), docs('operate/api-keys', 'Create API key')],
    blocks: ['guide'],
    anchors: ['create-api-key', 'account-api-keys'],
  },
  {
    id: 'time-zone',
    topic: 'setting',
    question: 'How do I change the time zone dates are shown in?',
    tools: SETTING_TOOLS,
    facts: [docs('operate/localization', 'Localization')],
    blocks: ['guide'],
    anchors: ['localization-time-zone'],
  },
  {
    id: 'ai-instructions',
    topic: 'setting',
    question: 'Where do I add instructions the AI reads for every diagnosis?',
    tools: SETTING_TOOLS,
    facts: [docs('features/ai-diagnosis', /instructions/i), docs('features/ai-diagnosis', 'Settings → AI')],
    blocks: ['guide'],
    anchors: ['ai-instructions', 'project-ai-instructions'],
  },
  {
    id: 'ai-language',
    topic: 'setting',
    question: 'Can the AI write its diagnoses in French?',
    tools: SETTING_TOOLS,
    facts: [docs('guide/ai-provider', 'PIWI_AI_LANGUAGE'), docs('guide/ai-provider', /response language/i)],
    blocks: ['guide'],
    anchors: ['ai-response-language'],
  },
  {
    id: 'wasted-time-patterns',
    topic: 'setting',
    question: 'What are wasted-time patterns, and where do I change them?',
    tools: SETTING_TOOLS,
    facts: [docs('features/slow-tests', /wait/i)],
    blocks: ['guide'],
    anchors: ['wasted-time-patterns'],
  },
  {
    id: 'ci-minute-cost',
    topic: 'setting',
    question: 'Where do I set what a CI minute costs us?',
    tools: SETTING_TOOLS,
    facts: [docs('features/quality-reports', 'Cost of a CI minute')],
    blocks: ['guide'],
    anchors: ['ci-minute-cost'],
  },
  {
    id: 'pr-comments',
    topic: 'setting',
    question: 'Where do I turn on pull-request comments?',
    tools: SETTING_TOOLS,
    facts: [docs('features/pr-feedback', 'Settings → Pull requests')],
    blocks: ['guide'],
    anchors: ['pr-feedback-settings'],
  },
  {
    id: 'auto-heal',
    topic: 'setting',
    question: 'What does auto-heal do, and where do I set it up?',
    tools: SETTING_TOOLS,
    facts: [docs('features/auto-heal', /pull request/i), docs('features/auto-heal', /locator/i)],
    blocks: ['guide'],
    anchors: ['auto-heal-settings'],
  },
  {
    id: 'pass-rate-target',
    topic: 'setting',
    question: "Where do I set a project's pass-rate target?",
    tools: SETTING_TOOLS,
    facts: [docs('features/analytics', 'Targets')],
    blocks: ['guide'],
    anchors: ['project-settings-targets'],
  },
  {
    id: 'project-capability-off',
    topic: 'setting',
    question: 'How do I turn off a capability for one project only?',
    tools: SETTING_TOOLS,
    facts: [docs('operate/capabilities', 'Capabilities'), docs('operate/capabilities', /declin/i)],
    blocks: ['guide'],
    anchors: ['project-capabilities', 'project-settings-capabilities'],
  },
  {
    id: 'ci-rerun-setting',
    topic: 'setting',
    question: 'What is the CI re-run setting of a project for?',
    tools: SETTING_TOOLS,
    facts: [docs('features/pr-feedback', /re-run/i), docs('features/pr-feedback', /workflow|pipeline/i)],
    blocks: ['guide'],
    anchors: ['project-ci-rerun'],
  },
  {
    id: 'smtp-edit',
    topic: 'setting',
    question: "Why can't I edit the SMTP settings in the dashboard?",
    tools: SETTING_TOOLS,
    facts: [
      docs('features/notifications', /environment variables only/i),
      docs('features/notifications', 'PIWI_SMTP_HOST'),
    ],
    blocks: ['guide'],
    anchors: ['smtp-email-delivery'],
  },
  {
    id: 'storage-backend',
    topic: 'setting',
    question: 'Where are traces and reports stored, and can I use S3?',
    tools: SETTING_TOOLS,
    facts: [docs('operate/storage', 'PIWI_STORAGE_TYPE'), docs('operate/storage', 'S3')],
    blocks: ['guide'],
    anchors: ['storage-backend'],
  },
  {
    id: 'assistant-model',
    topic: 'setting',
    question: 'Which model answers my questions here, and can I change it?',
    on: '/settings/ai',
    tools: SETTING_TOOLS,
    facts: [docs('features/assistant', /diagnosis model/i)],
    blocks: ['guide'],
    anchors: ['ai-assistant-model'],
  },
  {
    id: 'context-limits',
    topic: 'setting',
    question: 'What do the diagnosis context limits change?',
    tools: SETTING_TOOLS,
    facts: [docs('guide/ai-provider', /tokens/i), docs('guide/ai-provider', 'PIWI_AI_MAX_')],
    blocks: ['guide'],
    anchors: ['ai-context-limits'],
  },
  {
    id: 'open-in-ide',
    topic: 'setting',
    question: 'How do I make clicked source paths open in my editor?',
    tools: SETTING_TOOLS,
    facts: [docs('features/ide-integration', 'Open in IDE')],
    blocks: ['guide'],
    anchors: ['open-in-ide-settings', 'user-menu-open-in-ide'],
  },
];

const setup: LiveQuestion[] = [
  {
    id: 'github-actions',
    topic: 'setup',
    question: 'How do I send results from GitHub Actions?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ci', 'PIWI_DASHBOARD_URL'), docs('guide/ci', 'PIWI_API_KEY')],
    blocks: ['checklist', 'code', 'command'],
  },
  {
    id: 'gitlab-ci',
    topic: 'setup',
    question: 'How do I report runs from GitLab CI?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ci', 'PIWI_DASHBOARD_URL'), docs('guide/ci', /variables/i)],
    blocks: ['checklist', 'code'],
  },
  {
    id: 'ci-which',
    topic: 'setup',
    question: 'How do I run my suite in CI with Piwi?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ci', 'PIWI_DASHBOARD_URL')],
    blocks: ['question', 'checklist'],
  },
  {
    id: 'sharding',
    topic: 'setup',
    question: 'How do I merge sharded runs into one run?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ci', 'projectName'), docs('guide/ci', /run label/i)],
    blocks: ['checklist', 'code'],
  },
  {
    id: 'matrix-legs',
    topic: 'setup',
    question: 'My browser matrix legs merge into one run. How do I keep them apart?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ci', 'PIWI_RUN_LABEL')],
    blocks: ['code', 'checklist'],
  },
  {
    id: 'scm-access',
    topic: 'setup',
    question: "How do I let Piwi read my repository's diffs?",
    tools: [...DOCS_TOOLS, 'find_anchors'],
    facts: [docs('guide/source-control', 'SCM token'), docs('guide/source-control', 'Repository access')],
    blocks: ['checklist', 'guide'],
    anchors: ['project-scm-token', 'ai-repository-access'],
  },
  {
    id: 'gitlab-self-hosted',
    topic: 'setup',
    question: 'Our GitLab is self-hosted. How do I make Piwi use it?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/source-control', 'PIWI_SCM_GITLAB_HOSTS')],
    blocks: ['checklist', 'code'],
  },
  {
    id: 'ai-anthropic',
    topic: 'setup',
    question: 'How do I set up AI diagnosis with Anthropic?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ai-provider', 'PIWI_AI_PROVIDER'), docs('guide/ai-provider', 'PIWI_AI_API_KEY')],
    blocks: ['checklist', 'code'],
  },
  {
    id: 'ai-ollama',
    topic: 'setup',
    question: 'Can I use a local model with Ollama?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ai-provider', 'localhost:11434'), docs('guide/ai-provider', /openai/i)],
    blocks: ['code', 'checklist'],
  },
  {
    id: 'assistant-cheaper-model',
    topic: 'setup',
    question: 'How do I give the assistant a cheaper model than diagnosis?',
    tools: [...DOCS_TOOLS, 'find_anchors', 'get_instance_config'],
    facts: [env('PIWI_AI_ASSISTANT_MODEL', 'PIWI_AI_ASSISTANT_MODEL'), docs('guide/ai-provider', 'Model providers')],
    blocks: ['checklist', 'guide'],
    anchors: ['ai-assistant-model'],
  },
  {
    id: 'slack-alerts',
    topic: 'setup',
    question: 'How do I get a Slack message when a run fails?',
    tools: DOCS_TOOLS,
    facts: [
      docs('features/notifications', /incoming webhook/i),
      docs('features/notifications', 'Settings → Notifications'),
    ],
    blocks: ['checklist'],
  },
  {
    id: 'teams-alerts',
    topic: 'setup',
    question: 'How do I send alerts to a Microsoft Teams channel?',
    tools: DOCS_TOOLS,
    facts: [docs('features/notifications', 'Workflows')],
    blocks: ['checklist'],
  },
  {
    id: 'email-alerts',
    topic: 'setup',
    question: 'How do I set up email notifications?',
    tools: DOCS_TOOLS,
    facts: [docs('features/notifications', 'PIWI_SMTP_HOST'), docs('features/notifications', 'SMTP')],
    blocks: ['checklist', 'code'],
  },
  {
    id: 'webhook-signature',
    topic: 'setup',
    question: 'How can my webhook receiver check that a delivery really came from Piwi?',
    tools: DOCS_TOOLS,
    facts: [docs('features/notifications', 'X-Piwi-Signature'), docs('features/notifications', 'HMAC')],
    blocks: ['code', 'checklist'],
  },
  {
    id: 'jira-connect',
    topic: 'setup',
    question: 'How do I connect Jira?',
    tools: [...DOCS_TOOLS, 'find_anchors'],
    facts: [docs('operate/integrations', /api token/i), docs('operate/integrations', 'Check sign-in')],
    blocks: ['checklist', 'guide'],
    anchors: ['connect-integration', 'jira-connection-form'],
  },
  {
    id: 'jira-env',
    topic: 'setup',
    question: 'Can I configure the Jira connection with environment variables?',
    tools: DOCS_TOOLS,
    facts: [docs('operate/integrations', 'PIWI_JIRA_BASE_URL'), docs('operate/integrations', 'PIWI_JIRA_API_TOKEN')],
    blocks: ['code', 'checklist'],
  },
  {
    id: 'jira-webhook',
    topic: 'setup',
    question: 'How do Jira status changes reach Piwi sooner than the next sync?',
    tools: DOCS_TOOLS,
    facts: [docs('operate/integrations', 'Enable webhook')],
    blocks: ['checklist'],
  },
  {
    id: 'ci-account-role',
    topic: 'setup',
    question: 'Which role should our CI account have?',
    tools: DOCS_TOOLS,
    facts: [docs('operate/project-access', 'Uploader')],
  },
  {
    id: 'qa-maintainers',
    topic: 'setup',
    question: 'How do I give the QA team maintainer rights on every project?',
    tools: [...DOCS_TOOLS, 'find_anchors'],
    facts: [docs('operate/project-access', /group/i), docs('operate/project-access', 'All projects')],
    blocks: ['checklist', 'guide'],
    anchors: ['groups-list', 'add-group', 'permission-grid'],
  },
  {
    id: 'enable-auth',
    topic: 'setup',
    question: 'How do I turn on sign-in for this instance?',
    tools: [...DOCS_TOOLS, 'get_instance_config'],
    facts: [docs('operate/authentication', 'PIWI_AUTH_ENABLED'), docs('operate/authentication', 'PIWI_AUTH_SECRET')],
    blocks: ['checklist', 'code'],
  },
  {
    id: 'connect-suite',
    topic: 'setup',
    question: 'How do I connect my Playwright suite to this dashboard?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/getting-started', 'npx @piwitests/reporter init')],
    blocks: ['command', 'checklist'],
  },
  {
    id: 'capture-fixtures',
    topic: 'setup',
    question: 'How do I turn on the capture fixtures?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/capture-fixtures', 'fixtures.ts')],
    blocks: ['checklist', 'code'],
  },
  {
    id: 'connect-claude-code',
    topic: 'setup',
    question: 'How do I connect Claude Code to this instance?',
    tools: DOCS_TOOLS,
    facts: [docs('features/mcp', 'claude mcp add'), docs('features/mcp', '/mcp')],
    blocks: ['command', 'checklist'],
  },
  {
    id: 'merge-gate',
    topic: 'setup',
    question: 'How do I block a merge when tests that passed before start failing?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/ci', '--max-new-regressions'), docs('guide/ci', 'PIWI_OUTPUT_FILE')],
    blocks: ['code', 'checklist'],
  },
  {
    id: 'import-past-runs',
    topic: 'setup',
    question: 'How do I import runs from before we used Piwi?',
    tools: [...DOCS_TOOLS, 'find_anchors'],
    facts: [docs('guide/importing-runs', /blob/i)],
    blocks: ['checklist', 'guide'],
    anchors: ['import-choose-files', 'import-runs'],
  },
];

const piwi: LiveQuestion[] = [
  {
    id: 'what-is-piwi',
    topic: 'piwi',
    question: 'What is Piwi?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/what-piwi-does', 'Playwright'), docs('guide/what-piwi-does', /history/i)],
  },
  {
    id: 'four-jobs',
    topic: 'piwi',
    question: 'What are the four jobs Piwi does?',
    tools: DOCS_TOOLS,
    facts: [
      docs('guide/what-piwi-does', /keep(s)? the history/i),
      docs('guide/what-piwi-does', /explain(s)? the failures/i),
      docs('guide/what-piwi-does', /hand(s)? back a fix/i),
      docs('guide/what-piwi-does', /what your tests miss/i),
    ],
  },
  {
    id: 'telemetry',
    topic: 'piwi',
    question: 'Does Piwi send telemetry anywhere?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/privacy', /no telemetry/i)],
  },
  {
    id: 'license',
    topic: 'piwi',
    question: 'What license is Piwi under?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/license', 'FSL-1.1-MIT'), docs('guide/license', /two years/i)],
  },
  {
    id: 'cypress',
    topic: 'piwi',
    question: 'Can Piwi show my Cypress results?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/what-piwi-does', /Playwright[- ]only/i)],
  },
  {
    id: 'desktop-app',
    topic: 'piwi',
    question: 'What does the desktop app add?',
    tools: DOCS_TOOLS,
    facts: [docs('features/desktop', /no docker/i), docs('features/desktop', /reproduc/i)],
  },
  {
    id: 'failure-cluster',
    topic: 'piwi',
    question: 'What is a failure cluster?',
    tools: DOCS_TOOLS,
    facts: [docs('features/failure-clusters', /fingerprint/i)],
  },
  {
    id: 'execution-vs-test',
    topic: 'piwi',
    question: "What's the difference between an execution and a test case?",
    tools: DOCS_TOOLS,
    facts: [docs('guide/concepts', /attempt/i)],
  },
  {
    id: 'ai-optional',
    topic: 'piwi',
    question: 'Do I need an AI provider for Piwi to be useful?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/what-piwi-does', /deterministic/i)],
  },
  {
    id: 'piwi-picker',
    topic: 'piwi',
    question: 'What is Piwi Picker?',
    tools: DOCS_TOOLS,
    facts: [docs('features/extension', /locator/i), docs('features/extension', 'Chrome')],
  },
  {
    id: 'mcp-what',
    topic: 'piwi',
    question: "What can a coding agent do with Piwi's MCP server?",
    tools: DOCS_TOOLS,
    facts: [docs('features/mcp', /tools/i), docs('features/mcp', /triag/i)],
  },
  {
    id: 'vs-allure',
    topic: 'piwi',
    question: 'How is Piwi different from Allure Report?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/comparison', /history/i), docs('guide/comparison', /self-hosted/i)],
  },
  {
    id: 'assistant-what',
    topic: 'piwi',
    question: 'What can you do here, and can you change anything for me?',
    tools: DOCS_TOOLS,
    facts: [docs('features/assistant', /never changes|only reads|read-only/i)],
  },
  {
    id: 'hosted-saas',
    topic: 'piwi',
    question: 'Is there a hosted version of Piwi I can sign up for?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/comparison', /self-hosted/i)],
  },
  {
    id: 'requirements',
    topic: 'piwi',
    question: 'What do I need to run the dashboard?',
    tools: DOCS_TOOLS,
    facts: [docs('guide/getting-started', /Node(\.js)? 22/i), docs('guide/getting-started', 'Docker')],
  },
];

const showMe: LiveQuestion[] = [
  {
    id: 'show-flaky-list',
    topic: 'show-me',
    question: "Show me where this project's flaky tests are.",
    on: '/projects/1',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['flaky-tests-list', 'project-failures-tab'],
  },
  {
    id: 'show-quarantine-action',
    topic: 'show-me',
    question: 'Show me how to quarantine a flaky test.',
    on: '/projects/1?tab=flaky-tests',
    tools: GUIDE_TOOLS,
    facts: [docs('features/flaky-tests', 'Quarantine')],
    blocks: ['guide'],
    anchors: ['flaky-test-quarantine', 'quarantine-test'],
  },
  {
    id: 'show-diagnose',
    topic: 'show-me',
    question: 'Show me where to start an AI diagnosis of this.',
    on: '/failure-clusters/2',
    tools: GUIDE_TOOLS,
    facts: [docs('features/ai-diagnosis', 'Diagnose with AI')],
    blocks: ['guide'],
    anchors: ['diagnose-with-ai'],
  },
  {
    id: 'show-what-changed',
    topic: 'show-me',
    question: 'Show me what changed before this started failing.',
    on: '/failure-clusters/10',
    tools: GUIDE_TOOLS,
    facts: [docs('guide/source-control', 'What changed')],
    blocks: ['guide'],
    anchors: ['what-changed-card', 'what-changed-line', 'suspect-lines'],
  },
  {
    id: 'show-network',
    topic: 'show-me',
    question: 'Show me the network requests this test made.',
    on: '/test-run-cases/37',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['evidence-network'],
  },
  {
    id: 'show-trace',
    topic: 'show-me',
    question: 'Where do I open the Playwright trace?',
    on: '/test-run-cases/37',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['open-trace'],
  },
  {
    id: 'show-locator-fix',
    topic: 'show-me',
    question: 'Show me the suggested locator fix.',
    on: '/test-run-cases/87',
    tools: [...GUIDE_TOOLS, 'get_locator_healing'],
    facts: [],
    blocks: ['guide'],
    anchors: ['locator-fix'],
  },
  {
    id: 'show-run-changes',
    topic: 'show-me',
    question: 'Show me what changed since the previous run.',
    on: '/test-runs/2',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['run-changes', 'run-baseline-picker'],
  },
  {
    id: 'show-workers',
    topic: 'show-me',
    question: 'Show me the workers timeline.',
    on: '/test-runs/2',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['run-workers', 'run-timeline'],
  },
  {
    id: 'show-inbox',
    topic: 'show-me',
    question: 'Show me the failures I still need to triage.',
    on: '/',
    tools: GUIDE_TOOLS,
    facts: [docs('features/failure-clusters', 'Failure inbox')],
    blocks: ['guide'],
    anchors: ['failure-inbox', 'failure-inbox-row'],
  },
  {
    id: 'show-file-issue',
    topic: 'show-me',
    question: 'Show me how to file a Jira issue for this failure.',
    on: '/failure-clusters/1',
    tools: GUIDE_TOOLS,
    facts: [docs('operate/integrations', 'Create issue')],
    blocks: ['guide'],
    anchors: ['create-issue', 'issue-line'],
  },
  {
    id: 'show-ai-model',
    topic: 'show-me',
    question: 'Show me where to configure the AI model.',
    tools: GUIDE_TOOLS,
    facts: [docs('guide/ai-provider', 'Settings → AI')],
    blocks: ['guide'],
    anchors: ['ai-diagnosis-model', 'ai-model-providers'],
  },
  {
    id: 'show-slack-channel',
    topic: 'show-me',
    question: 'Show me how to add a Slack channel for alerts.',
    tools: GUIDE_TOOLS,
    facts: [docs('features/notifications', 'Settings → Notifications')],
    blocks: ['guide'],
    anchors: ['add-notification-channel', 'notification-channels', 'notification-channel-form'],
  },
  {
    id: 'show-project-access',
    topic: 'show-me',
    question: 'Show me where to give someone access to a project.',
    tools: GUIDE_TOOLS,
    facts: [docs('operate/project-access', 'Settings → Permissions')],
    blocks: ['guide'],
    anchors: ['permission-grid', 'project-settings-members', 'user-row-actions'],
  },
  {
    id: 'show-api-key',
    topic: 'show-me',
    question: 'Show me where to create an API key for CI.',
    tools: GUIDE_TOOLS,
    facts: [docs('operate/api-keys', 'Create API key')],
    blocks: ['guide'],
    anchors: ['create-api-key', 'account-api-keys', 'user-row-actions'],
  },
  {
    id: 'show-mcp',
    topic: 'show-me',
    question: 'Show me how to connect an MCP client.',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['mcp-setup', 'mcp-page'],
  },
  {
    id: 'show-capabilities',
    topic: 'show-me',
    question: 'Show me which capabilities this instance uses.',
    tools: GUIDE_TOOLS,
    facts: [docs('operate/capabilities', 'Setup')],
    blocks: ['guide'],
    anchors: ['setup-ladder', 'capability-presets'],
  },
  {
    id: 'show-test-history',
    topic: 'show-me',
    question: "Show me this test's history.",
    on: '/test-run-cases/37',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['execution-test-history', 'test-case-header'],
  },
  {
    id: 'show-flake-lab',
    topic: 'show-me',
    question: 'Show me the Flake Lab results for this test.',
    on: '/test-cases/9',
    tools: GUIDE_TOOLS,
    facts: [docs('features/flake-lab', 'Flakiness')],
    blocks: ['guide'],
    anchors: ['test-flakiness', 'flake-suspects'],
  },
  {
    id: 'show-file-tests',
    topic: 'show-me',
    question: 'Show me which tests run UsersEndpoints.cs.',
    on: '/projects/5/coverage',
    tools: [...GUIDE_TOOLS, 'get_coverage'],
    facts: [example('file-coverage-server', 'UsersEndpoints.cs')],
    blocks: ['guide'],
    anchors: ['coverage-file-heading', 'coverage-source-marks', 'coverage-files'],
  },
  {
    id: 'show-command-palette',
    topic: 'show-me',
    question: 'How do I jump to any page quickly?',
    tools: GUIDE_TOOLS,
    facts: [docs('reference/keyboard-shortcuts', /ctrl ?\+ ?k/i)],
    blocks: ['guide'],
    anchors: ['command-palette'],
  },
  {
    id: 'show-analytics-period',
    topic: 'show-me',
    question: 'Show me how to change the period analytics covers.',
    on: '/analytics',
    tools: GUIDE_TOOLS,
    facts: [],
    blocks: ['guide'],
    anchors: ['analytics-period-button', 'analytics-period', 'analytics-filters'],
  },
];

export const LIVE_QUESTIONS: readonly LiveQuestion[] = [
  ...failure,
  ...flaky,
  ...run,
  ...setting,
  ...setup,
  ...piwi,
  ...showMe,
];

/**
 * The page context the panel sends with a question asked on `question.on`:
 * the route's numeric segment is the page's `[id]`, as every page of the
 * dashboard names its entity.
 */
export function questionContext(question: Pick<LiveQuestion, 'on'>): AssistantPageContext | null {
  if (!question.on) return null;
  const url = new URL(question.on, 'http://localhost');
  const id = url.pathname.split('/').find((segment) => /^\d+$/.test(segment));
  return assistantPageContext({
    path: url.pathname,
    fullPath: question.on,
    recordPath: url.pathname.replace(/\/\d+(?=\/|$)/, '/:id()'),
    params: id ? { id } : {},
    query: Object.fromEntries(url.searchParams),
  });
}
