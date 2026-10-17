/**
 * MCP tool catalog — the single source of truth for tool names, descriptions,
 * and input schemas exposed by the Piwi Dashboard MCP server.
 *
 * Lives in `shared/` because it is consumed from two places:
 *  - `server/utils/mcp/tools.ts` attaches a DB-backed handler to each entry and
 *    serves them over the `/mcp` JSON-RPC endpoint (`tools/list` / `tools/call`).
 *  - `app/pages/mcp.vue` renders the catalog in the UI.
 *
 * This module must stay free of server-only imports (DB, storage, drizzle) so it
 * can be bundled into the browser. Behavior (the handlers) lives next to the
 * server; only the pure data lives here.
 */
import type { CapabilityId, CapabilityModule } from '#shared/capabilities';
import type { Permission } from '#shared/permissions';
import { EXTRACT_SYSTEM_PROMPT } from './test-function-extract-prompt';
import { DESCRIBE_PIWI_TOPICS } from '#shared/piwi-ecosystem';
import { REPORT_LANGUAGES } from './reports/languages';

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface McpToolDef {
  name: string;
  description: string;
  /** The preset a tool belongs to; `?modules=` on the MCP URL narrows the list to a set of these. */
  module: CapabilityModule;
  /**
   * The declinable capability a tool depends on, when it depends on one. The
   * route drops a tool from `tools/list` and `tools/call` when this capability
   * is declined at instance level; a tool with no `capability` is never dropped.
   */
  capability?: CapabilityId;
  /**
   * The permission a write or administrator tool needs, the one its REST twin
   * declares in `x-required-permission`; with several, any one of them (the
   * handler checks the one its arguments call for). `tools/list` leaves out a
   * tool whose permission the caller holds on no project, and the handler
   * checks it on the project it acts on. Read tools declare none: the project
   * scope decides what they read.
   */
  permission?: Permission | readonly Permission[];
  // `required` is `readonly` so the catalog below can be declared `as const`
  // (needed to derive the `McpToolName` union) while still satisfying this type.
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: readonly string[] };
}

/** A tool's `permission` as a list; empty for a read tool. */
export function toolPermissions(tool: Pick<McpToolDef, 'permission'>): readonly Permission[] {
  if (tool.permission === undefined) return [];
  return typeof tool.permission === 'string' ? [tool.permission] : tool.permission;
}

/** The analytics scope, as the report and metric tools take it (the analytics page's URL keys). */
const ANALYTICS_SCOPE_PROPERTIES = {
  projectIds: {
    type: 'array',
    items: { type: 'number' },
    description: 'Project IDs to cover (default: every project you can see)',
  },
  period: {
    type: 'string',
    description:
      'Period: last-7d, last-30d (default), this-week, last-month, this-quarter, 2026-08-01..2026-08-31, since-marker-<id>, release-0 (this release cycle), all',
  },
  compare: {
    type: 'string',
    description: 'Comparison: previous (default), previous-unit, year, none, or YYYY-MM-DD..YYYY-MM-DD',
  },
  environments: { type: 'array', items: { type: 'string' }, description: 'Only runs reported for these environments' },
  branches: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only runs on these branches (default: each project’s default branch plus runs with no known branch)',
  },
  allBranches: { type: 'boolean', description: 'Count every branch instead of the default branches' },
  selection: { type: 'string', description: 'Test filter: a selection key (e.g. smoke), resolved in each project' },
  tags: { type: 'array', items: { type: 'string' }, description: 'Test filter: tests carrying all of these tags' },
  owners: {
    type: 'array',
    items: { type: 'string' },
    description: 'Test filter: tests held by any of these owners (piwi:owner or CODEOWNERS)',
  },
} as const;

export const MCP_TOOL_DEFS = [
  {
    name: 'list_projects',
    module: 'core',
    description:
      'List all projects with stats: total runs, test cases, latest run status and branch. Use this first to discover available projects and their IDs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project',
    module: 'core',
    description:
      'Get project details and its recent test runs with pass/fail counts. Results are paginated — use pageSize and cursor for the runs list.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        pageSize: { type: 'number', description: 'Runs per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to get the next page of runs' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_runs',
    module: 'core',
    description: 'List test runs for a project with filters.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        status: {
          type: 'string',
          enum: ['passed', 'failed', 'timedout', 'interrupted', 'running', 'cancelled', 'initializing', 'finalizing'],
          description: 'Filter by run status (exact match against the stored value)',
        },
        branch: { type: 'string', description: 'Filter by branch name (exact match against the run branch)' },
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to get the next page' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_run',
    module: 'core',
    description:
      'Get a test run summary plus its test cases (paginated), with status, truncated error text, and failure cluster IDs. Filter by status and page with pageSize/cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'Test run ID' },
        statusFilter: {
          type: 'string',
          enum: ['failed', 'flaky', 'all'],
          description:
            'Which test cases to include (default: "failed" — only failed+timedOut; "flaky" — only flaky; "all" — every case)',
        },
        pageSize: { type: 'number', description: 'Cases per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response for the next page of cases' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'list_failed_cases',
    module: 'core',
    description:
      'List failed and timed-out test cases across recent runs for a project. Each item carries a one-line headline explaining the failure ahead of the truncated error.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to get the next page' },
        runId: { type: 'number', description: 'Optional: restrict to a specific run' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_flaky_tests',
    module: 'core',
    description:
      'List flaky tests for a project with flakiness scores. A test whose Flake Lab verify experiment held is left out until it retry-passes again.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        runs: { type: 'number', description: 'Number of recent runs to analyze (default 50, max 200)' },
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        cursor: {
          type: 'string',
          description: 'Opaque cursor from a previous response. Cursor is the flakyScore value (descending).',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_test_case',
    module: 'core',
    description:
      'Get test case details including aggregated pass/fail stats, flakiness metrics, and recent executions (paginated). Use testCaseId (stable identity), not the per-run caseId.',
    inputSchema: {
      type: 'object',
      properties: {
        testCaseId: {
          type: 'number',
          description: 'Test case ID (testCaseId from list_failed_cases or list_flaky_tests)',
        },
        pageSize: { type: 'number', description: 'Executions per page (default 10, max 50)' },
        cursor: {
          type: 'string',
          description: 'Opaque cursor from a previous response to get the next page of executions',
        },
      },
      required: ['testCaseId'],
    },
  },
  {
    name: 'list_clusters',
    module: 'core',
    description: 'List failure clusters for a project. Each cluster groups similar failures by error fingerprint.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        status: {
          type: 'string',
          enum: ['open', 'resolved', 'ignored'],
          description: 'Filter by triage status (default: all statuses)',
        },
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to get the next page' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_cluster',
    module: 'core',
    description:
      'Get full details for a failure cluster including all affected test cases, a compact diagnosis summary, and locator healing suggestions for up to 5 affected cases. Each healing entry includes the failing locator, the recommended fix, and the number of alternatives available. `mergeSuggestions` lists the pending suggestions to merge it with another cluster (suggestionId, otherClusterId), to decide with decide_merge_suggestion. Use get_cluster_diagnosis for the full diagnosis text, or get_cluster_context for the raw AI evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID from list_clusters' },
      },
      required: ['clusterId'],
    },
  },
  {
    name: 'get_fix_plan',
    module: 'core',
    description:
      'Everything needed to fix one failure cluster, in a single answer: the diagnosis and its validated patch, ranked locator replacements each with the exact file and line and a ready-to-apply `edit` (the rewritten line plus a unified diff `git apply` accepts), the failing tests, the owning team, `suspectLines` (the changed lines since the last green run that the failing tests executed, the top five with their files, line ranges and scores, so you know where to look first; `available: false` with a `reason` when the tests recorded no coverage or the diff could not be read), the command that verifies the work, a `reproduce` recipe (checkout, pinned install, browser install and the exact test command as `{ bash, powershell }` steps), and a `bisect` script (`git bisect` between the last green and the failing commit, or `available: false` with a reason). `verify.expectation` states what the dashboard records once those tests pass, so you can confirm the fix landed rather than guessing. It also carries the `story`, the `situation` (since when, whether a newer execution failed again or passed, the cluster and its owner) and the computed `nextStep` for the cluster. Prefer this over assembling get_cluster + get_cluster_diagnosis + get_locator_healing yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID from list_clusters or list_open_clusters' },
      },
      required: ['clusterId'],
    },
  },
  {
    name: 'get_cluster_diagnosis',
    module: 'agents',
    description:
      "Get the stored diagnosis of a failure cluster, written by Piwi's AI (run_cluster_diagnosis) or by an agent (record_diagnosis). Returns category, confidence, root cause, evidence, and suggested fix. Returns null if the cluster has no diagnosis yet.",
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID' },
      },
      required: ['clusterId'],
    },
  },
  {
    name: 'get_execution_diagnosis',
    module: 'agents',
    description:
      "Get the stored diagnosis of one failing execution (a failure), written by Piwi's AI (run_execution_diagnosis) or by an agent (record_diagnosis with executionId), in the shape get_cluster_diagnosis returns. Returns null when the execution has none; a failure in a cluster usually shares the cluster's diagnosis (get_cluster_diagnosis).",
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'number', description: 'Test run case ID (executionId)' },
      },
      required: ['executionId'],
    },
  },
  {
    name: 'get_test_case_context',
    module: 'core',
    description:
      'Get the AI evidence context for a specific test-run-case (execution scope). Use this when debugging a single test failure — it provides the execution-scoped evidence including steps, console, network, and SCM diff.',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'number', description: 'Test run case ID' },
      },
      required: ['executionId'],
    },
  },
  {
    name: 'get_case_screenshots',
    module: 'core',
    description:
      "Get screenshots for a test-run-case, the page the test failed on first and flagged atFailure when it is known: the capture fixtures' screenshot of the page the test last acted on, or the only screenshot. Playwright takes one per page still open at the failure and one per page of each context the test closed before, so among several none is flagged without the fixtures. By default returns metadata only (file name, media type, size) for every screenshot. Set content=true to include base64-encoded image data for the first 3 (capped at ~100 KB each). Call metadata-only first to discover what exists, then request content for the ones you need.",
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'number', description: 'Test run case ID' },
        content: { type: 'boolean', description: 'Include base64 image data (default false — metadata only)' },
      },
      required: ['executionId'],
    },
  },
  {
    name: 'get_cluster_context',
    module: 'core',
    description:
      'Get the full AI evidence context for a failure cluster — the same data sent to the diagnosis AI. Includes error samples, stack traces, test steps, console logs, network failures, ARIA snapshots, SCM diff (changed files since last green run), and a per-section breakdown with char counts and truncation flags. This is the richest available evidence for debugging a failure.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID' },
        baseCommit: {
          type: 'string',
          description: 'Optional: override the baseline commit SHA for SCM diff comparison',
        },
        selectedCommitShas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific commit SHAs to include in the diff context (max 10)',
        },
      },
      required: ['clusterId'],
    },
  },
  {
    name: 'search_test_cases',
    module: 'core',
    description:
      "Search test cases by title or file path within a project. Accepts a free-text query and returns matching test cases with basic stats. Use this to find a test case when you don't know its ID.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        q: {
          type: 'string',
          description: 'Search query — matched against title and file path, ignoring case and accents',
        },
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to get the next page' },
      },
      required: ['projectId', 'q'],
    },
  },
  {
    name: 'get_test_run_case',
    module: 'core',
    description:
      'Get a single test-run-case execution record with a one-line failure headline, the full (untruncated) error text plus steps, console logs, web vitals, and ARIA snapshot. Use include to fetch only the blobs you need. The ID is the executionId from get_run.cases or testRunsCaseId from get_cluster.affectedTestCases.',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: {
          type: 'number',
          description:
            'Test run case ID (executionId from get_run.cases or testRunsCaseId from get_cluster.affectedTestCases)',
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['steps', 'console', 'webVitals', 'aria', 'source'] },
          description:
            'Optional: which heavy blobs to include (default: all). The error, status, and summary are always returned.',
        },
      },
      required: ['executionId'],
    },
  },
  {
    name: 'list_recent_activity',
    module: 'core',
    description:
      'List the most recent test runs across all projects. No projectId required — returns a cross-project view of recent CI activity. Paginated by startTime descending.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to get the next page' },
      },
    },
  },
  {
    name: 'get_repo_commits',
    module: 'core',
    capability: 'scm',
    description:
      "List recent commits for a project's repository. Requires SCM token configuration (per-project or global). Returns commit details (SHA, message, author, date).",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        branch: { type: 'string', description: 'Branch name (default: repository default branch)' },
        limit: { type: 'number', description: 'Max commits (default 20, max 100)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_repo_diff',
    module: 'core',
    capability: 'scm',
    description:
      "Get the diff (changed files with patches) for a single commit in a project's repository. Requires SCM token configuration (per-project or global). Useful for inspecting what code changed in a specific commit suspected of causing a failure.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        sha: { type: 'string', description: 'Full commit SHA' },
      },
      required: ['projectId', 'sha'],
    },
  },
  {
    name: 'get_run_insights',
    module: 'core',
    description:
      'Compare a run to its baseline: pass-rate delta, new regressions, recurrences, recovered tests, new flaky tests, biggest perf improvements/regressions, worker imbalance, and newly opened clusters. The baseline is the last passing run in the same environment, on the same branch, else the branch it forked from, else any; when no earlier full run passed, the last failed run, found the same way. `baseline` names why it was chosen. Use this to answer "what changed?" and "did my fix work?".',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'Test run ID' },
        baseBranch: {
          type: 'string',
          description:
            'Optional: take the baseline from this branch only (its last passing run, else its last failed run, same environment first) instead of the automatic choice',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_spec_health',
    module: 'core',
    description:
      'Per-spec-file health for a project: pass rate, flaky rate, failure count, execution count (`testCount`), and average duration grouped by spec-file prefix over the last N days. Use to find which areas of the suite are unhealthy.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        days: { type: 'number', description: 'Lookback window in days (default 30, max 90)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_slow_tests',
    module: 'core',
    capability: 'fixtures',
    description:
      'Slowest test cases in a project by average duration, with max/min and trend direction across recent runs. Use to target performance work.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        runs: { type: 'number', description: 'Recent runs to analyze (default 50, max 100)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_performance_trend',
    module: 'core',
    capability: 'fixtures',
    description:
      'Time series of run duration, average test duration, and p90 test duration for a project. Use to answer "is the suite getting slower?".',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        limit: { type: 'number', description: 'Number of recent runs (default 30, max 100)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_test_stability_trend',
    module: 'core',
    description:
      'Time-series stability for a single test case: flaky rate, pass rate, and average duration in UTC time buckets (about 31 of them) over the last N days. Use to answer "is this test getting flakier?".',
    inputSchema: {
      type: 'object',
      properties: {
        testCaseId: { type: 'number', description: 'Test case ID (stable testCaseId)' },
        days: { type: 'number', description: 'How many days back the trend reaches (default 90, 1–3650)' },
      },
      required: ['testCaseId'],
    },
  },
  {
    name: 'get_flake_profile',
    module: 'workflow',
    capability: 'flake-lab',
    description:
      'The suspects of a flaky test, read from its last 30 days (at most 200 attempts): the slow or failed routes, the tests running alongside or just before it on the same worker, the load and the browser project its failures share and its passes do not. Each suspect has its raw counts (failuresWith of failures, passesWith of passes), its lift and the condition that would test it (delay a route, fail it, throttle the CPU, run another test alongside or first, pin a project); at most 5, a suspect needs 3 failures and a lift of 2. Alongside suspects list the paths both tests write and say when the overlap crossed shards (approximate). `context` holds factors with no condition (first attempt, UTC hour, another run on the environment). `experiments` lists the test’s latest finished `piwi flake` experiments (at most 10, newest first): kind (reproduce or verify), verdict, the commit it ran and the commit of the failures, and each arm with its conditions, runs, matching failures (same error as history), other failures, p-value against the control and verdict; each suspect also carries `lab`, its latest arm result. Use it before changing a flaky test, to know what to reproduce and whether a fix was verified.',
    inputSchema: {
      type: 'object',
      properties: {
        testCaseId: { type: 'number', description: 'Test case ID (testCaseId from list_flaky_tests)' },
      },
      required: ['testCaseId'],
    },
  },
  {
    name: 'plan_flake_experiment',
    module: 'workflow',
    capability: 'flake-lab',
    description:
      'The Flake Lab plan for a flaky test, for an agent that runs the lab itself: the `piwi flake` and `piwi flake verify` commands to run from the project root, the control arm and one arm per suspect (most likely first) with the conditions each applies (delay or fail a route, throttle the CPU, run another test alongside or first, pin a project), the runs and the early stop, the error signatures a failure must match, and an estimate from the test’s median duration. Records nothing: the command records the experiment when it runs. `plan` is the full plan, which `piwi flake --plan <file>` also accepts to run without the dashboard. After a fix, run the verify command: exit 0 means the fix held under the condition that reproduced the failure.',
    inputSchema: {
      type: 'object',
      properties: {
        testCaseId: { type: 'number', description: 'Test case ID (testCaseId from list_flaky_tests)' },
      },
      required: ['testCaseId'],
    },
  },
  {
    name: 'get_network_requests',
    module: 'core',
    capability: 'fixtures',
    description:
      "A run's network requests aggregated by method + normalized route, sorted by average duration: request count, average, p90 and max duration, error rate, and the tests that made them. Use to pin a UI failure on a slow or failing endpoint; the backend logs of one failing test are in explain_failure and get_test_case_context.",
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: 'Test run ID' } },
      required: ['runId'],
    },
  },
  {
    name: 'list_resource_findings',
    module: 'workflow',
    capability: 'resources',
    description:
      'A project’s resource findings across runs, the most recently seen first: browsers, contexts, pages and API contexts left open past the test or describe block that opened them (leaked), pages opened and never used (idle), pages, listeners or route handlers growing on a long-lived page (piling), Node servers or file watchers a test left running in its worker (handle), and leaks counted from steps without the capture fixtures (probable). Each has where it was opened (`site` is the `file:line` to edit), the run it was first and last seen in, how many runs showed it, and its status: `open`, or `fixed` once five full runs of the default branch came without it (`cleanRuns` counts them; `reopenedRunId` is set when a fixed one came back). `last` is what it held the last time it showed: objects, tests, how long it stayed open, page CPU after its test. Use it before touching a suite’s fixtures or teardown, or to check a leak fix held.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        status: { type: 'string', enum: ['open', 'fixed', 'all'], description: 'Which findings (default open)' },
        verdict: {
          type: 'string',
          enum: ['leaked', 'idle', 'piling', 'handle', 'probable'],
          description: 'Only findings with this verdict',
        },
        limit: { type: 'number', description: 'Max findings (default 50, max 200)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_resource_profile',
    module: 'workflow',
    capability: 'resources',
    description:
      'What one run cost and left open, from its reporters’ resource reports (one per shard): the findings, each with whether its base branch (the pull request’s target, else the default branch) had shown it before (`isNew`); the machine each shard ran on (cores, memory, how busy its CPUs were, the share of time a task waited for a CPU, CPU time by process role, peak memory and the largest process, disk); the busiest open pages per worker; and the costliest tests by the CPU of their worker and browser processes, with the pages each found already open. Null fields were not measured on that platform. Use it to explain a slow or timing-out run, or to find which tests a leak slows down.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: 'Test run ID' } },
      required: ['runId'],
    },
  },
  {
    name: 'get_failure_groups',
    module: 'core',
    description:
      "One run's failures grouped by failure cluster, with per-group affected cases and worker correlation. Run-scoped counterpart to list_clusters.",
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: 'Test run ID' } },
      required: ['runId'],
    },
  },
  {
    name: 'get_locator_healing',
    module: 'healing',
    capability: 'locator-healing',
    description:
      'Ranked alternative locators for a failing test-run-case: the failing locator, the recommended durable fix, and the full alternative lists (from prior success, element match, and ARIA snapshot). Includes `location` (file:line:col), the failing `sourceLine`, and a ready-to-apply `edit` — the rewritten line plus a unified diff `git apply` accepts. Returns `{ applicable: false, reason }` when the locator resolved and the failure came after (or the error is a navigation error) — do not rewrite the selector then. Use when fixing a broken selector.',
    inputSchema: {
      type: 'object',
      properties: { executionId: { type: 'number', description: 'Test run case ID (executionId)' } },
      required: ['executionId'],
    },
  },
  {
    name: 'predict_locator_breaks',
    module: 'healing',
    description:
      "Which of the project's test locators a change breaks, before any test runs. Send your own working diff (the output of `git diff`, unified format): the strings it removes or renames (attribute values such as aria-label, placeholder or a test id, text between tags, quoted strings, translation values) are matched against every locator chain the project's tests used, under Playwright's text rules (case-insensitive substring unless exact, regex as written). Each break carries its confidence (`likely` for an attribute, tag text or translation; `possible` for a bare string), the tests and call sites (`file:line:col`, relative to where the reporter ran), and for a one-to-one rename the `rewrite` (the same chain with the new string) plus `edits`: replace each `before` string literal with `after` at the call sites. Run it after a UI change, apply the edits, then run the tests it names. Test files in the diff are ignored. `branch` picks the locator index to compare with (default: the project's default branch).",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        diff: { type: 'string', description: 'The change as a unified diff (`git diff` output)' },
        branch: {
          type: 'string',
          description: "Branch whose locator index to compare with (default: the project's default branch)",
        },
      },
      required: ['projectId', 'diff'],
    },
  },
  {
    name: 'search',
    module: 'core',
    description:
      'Global search across all in-scope projects, runs (by label or numeric id), test cases (by title) and failure clusters (by title, signature, `#id`, or the key of a linked issue such as PROJ-123). Use to find a run by its label, the cluster a ticket tracks, or an entity across projects.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Search query (min 2 chars)' } },
      required: ['q'],
    },
  },
  {
    name: 'list_case_traces',
    module: 'core',
    description:
      'List Playwright trace files for a test-run-case, with a download path for each. Fetch the bytes via GET /api/files/<path>.',
    inputSchema: {
      type: 'object',
      properties: { executionId: { type: 'number', description: 'Test run case ID (executionId)' } },
      required: ['executionId'],
    },
  },
  {
    name: 'list_links',
    module: 'workflow',
    capability: 'integrations',
    description:
      'List external entity links (Jira, GitHub PR/issue, etc.) attached to a run, test-run-case, test case, or failure cluster, with provider and unfurled status.',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: ['test_run', 'test_runs_case', 'test_case', 'failure_cluster'],
          description: 'Which entity the links are attached to',
        },
        entityId: { type: 'number', description: 'The entity ID matching entityType' },
      },
      required: ['entityType', 'entityId'],
    },
  },
  {
    name: 'create_issue',
    module: 'workflow',
    capability: 'integrations',
    permission: 'issue:create',
    description:
      "File a Jira issue from a failure cluster or a failing execution, with the fix plan as its body — the same ticket the dashboard's Create issue button produces. The issue is deduped by cluster, so calling twice for the same cluster returns the existing action rather than a second ticket. Returns the issue { key, url } and any `existing` issues that already track the cluster (a pinned link, a matching label, or a fixed-before match) so you can link instead of filing again. Requires a Jira connection and a project binding (project key and issue type); the binding's field defaults fill the fields the project requires. Requires `issue:create` (Contributor and above on the project).",
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: ['failure_cluster', 'test_runs_case', 'bug_report'],
          description: 'Whether to file for a failure cluster, one failing execution, or a bug report',
        },
        entityId: {
          type: 'number',
          description: 'The cluster id, the execution (testRunsCaseId) or the bug report id',
        },
        title: { type: 'string', description: 'Optional issue title; defaults to the cluster name' },
        includeDiagnosis: {
          type: 'boolean',
          description: 'Include the AI diagnosis summary and root cause (default true)',
        },
        includePatch: { type: 'boolean', description: 'Include the suggested patch as a diff (default true)' },
        locale: {
          type: 'string',
          enum: ['en', 'fr'],
          description: "The ticket's language; defaults from the project/connection binding, else English",
        },
        fields: {
          type: 'object',
          description:
            'Values for Jira fields the project requires, keyed by field id — e.g. { "customfield_10050": "Critical" }. A listed value can be given by its name, a person by account id, rich text as plain text; anything else as Jira\'s API takes it. Overrides the project\'s field defaults. When a required field is still empty, the call fails naming each field, its id and what it takes.',
        },
      },
      required: ['entityType', 'entityId'],
    },
  },
  {
    name: 'list_tags',
    module: 'core',
    capability: 'tags',
    description: 'List every tag defined on this instance (id, text, color). Tags are instance-wide, not per-project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project_test_catalog',
    module: 'workflow',
    description:
      'The full test-case catalog for a project with aggregated pass/fail/flaky counts, average duration, and last status per test. Offset-paginated bulk companion to get_test_case.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        offset: { type: 'number', description: 'Row offset for paging (default 0)' },
        query: {
          type: 'string',
          description:
            'Optional search, as in the catalog search box: words match the title, describe blocks or file path; qualifiers match one field (file:, describe:, title:, tag:, lock:, owner:, priority:, feature:); a leading - excludes; * is a wildcard in text fields',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags; a test must carry every one of them. A leading @ is optional.',
        },
        locks: {
          type: 'string',
          description: 'Comma-separated lock names; a test must carry every one of them.',
        },
        owner: { type: 'string', description: 'Exact owner declared via the piwi:owner annotation' },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Priority declared via the piwi:priority annotation',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_selections',
    module: 'workflow',
    description:
      "A project's saved test selections plus the built-in ones (failed, quarantine-free). A selection is a named, declarative subset of the suite resolved from run history. Use resolve_selection to turn one into the tests to run.",
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'number', description: 'Project ID from list_projects' } },
      required: ['projectId'],
    },
  },
  {
    name: 'resolve_selection',
    module: 'workflow',
    description:
      'Resolve a saved (or built-in) selection to the tests it currently matches and a ready-to-run `playwright test` command. Just landed a fix? Resolve the relevant selection to get the exact command that verifies it.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        key: { type: 'string', description: 'Selection key, e.g. "smoke" (or a built-in: failed, quarantine-free)' },
        format: {
          type: 'string',
          enum: ['args', 'grep', 'files', 'json'],
          description: 'Materialization of the command: args = file:line (default), grep, files, or json (no command)',
        },
        budgetMs: { type: 'number', description: 'Optional time budget in ms — take the best tests that fit' },
      },
      required: ['projectId', 'key'],
    },
  },
  {
    name: 'preview_selection',
    module: 'workflow',
    description:
      'Resolve an ad-hoc selection definition without saving it — the dry-run behind the builder. Supply a definition (include/exclude predicate groups, pins, budget, limit) and get back the matching tests, an estimate, warnings and a command. An unknown predicate is an error, not ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        definition: {
          type: 'object',
          description:
            'A SelectionDefinition: { include?: group[], exclude?: group[], pins?, budget?, limit? }. A group ANDs predicates like tags, priority, files (globs), flaky, minPassRate, maxAvgDurationMs, lastStatus, failedInLastRuns.',
        },
        format: {
          type: 'string',
          enum: ['args', 'grep', 'files', 'json'],
          description: 'Command materialization (default args)',
        },
      },
      required: ['projectId', 'definition'],
    },
  },
  {
    name: 'suggest_selections',
    module: 'workflow',
    description:
      'Suggest tags and a smoke suite for a project from observed history (suggest-only, with evidence). Returns `slow` tags for duration outliers, `feature` tags from the route families tests hit, and a mined smoke suite — a budgeted set cover over observed routes, each pick buying fewer new routes than the last. The smoke suite lists any `splitLocks` (locks held by more than one pick), which plain `playwright test --shard` could split across shards — run it with `piwi run --shard` (lock-aware) instead. `budgetMs` caps the smoke suite (default 5 min).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        budgetMs: { type: 'number', description: 'Time budget in ms for the mined smoke suite (default 300000)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'analyze_selections',
    module: 'workflow',
    description:
      'Health and drift for a project\'s selections. For each: what it resolves to now (count, quarantined members, duration, warnings — including a `split-lock` warning when a lock is shared by more than one test, which Playwright\'s own `--shard` could split across shards) and whether that differs from what its most recent stamped run recorded — a silent drift a green build can hide. Plus coverage: how many tests are matched by no stored selection (the "unselected" gap), with a sample. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'number', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'list_open_clusters',
    module: 'core',
    description:
      'Open failure clusters across all in-scope projects, ranked by occurrences — a cross-project triage queue, the same one the dashboard failure inbox shows. Filter by status, or by an inbox `queue` to focus (regressions on the default branch, fixes that did not hold, quarantines ready for release, merge suggestions awaiting a decision, the ones needing a ticket, or the ones assigned to you). A `queue` filter implies open clusters and excludes snoozed ones. Paginate with pageSize/cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'resolved', 'ignored'], description: 'Triage status (default: open)' },
        queue: {
          type: 'string',
          enum: ['mine', 'needs-ticket', 'regressions', 'fix-didnt-hold', 'quarantine-ready', 'merge-suggestions'],
          description: 'Focus one inbox queue (open, non-snoozed clusters only); overrides status',
        },
        pageSize: { type: 'number', description: 'Results per page (default 10, max 50)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to get the next page' },
      },
    },
  },
  {
    name: 'get_instance_stats',
    module: 'core',
    permission: 'storage:manage',
    description:
      'Instance-wide counts (projects, runs, test cases, executions, files) and total storage size. Requires `storage:manage` (administrators only).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'explain_failure',
    module: 'core',
    description:
      "One-call evidence bundle for a single failing execution: a one-line headline (for a test that passed on retry, its failed attempt's, named in `failedAttempt` by its executionId and retry index, 0 for the first attempt, to call this tool on), the error, steps, console, ARIA snapshot, the recommended locator fix, the structural page diff against the last green sample, a screenshot count, and the AI diagnosis context. It also carries the `story` (the clues chained into one sentence when a known combination matches), the `situation` (since when, on which commit, whether a newer execution of the test failed again or passed, in how many tests, who owns it), `didNotRun` (why a test that did not run never started, in one sentence), `latest` (whether this is the latest execution of the test in its Playwright project, else the executionId, runId and status of the newest one) and the computed `nextStep`. Prefer this over chaining get_test_run_case + get_locator_healing + get_test_case_context.",
    inputSchema: {
      type: 'object',
      properties: { executionId: { type: 'number', description: 'Test run case ID (executionId)' } },
      required: ['executionId'],
    },
  },
  {
    name: 'set_cluster_status',
    module: 'core',
    permission: 'triage:write',
    description:
      'Triage a failure cluster: set its status to open, resolved, or ignored with an optional note. Requires `triage:write` (Maintainer and above on the project). Use after fixing the underlying issue.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID' },
        status: { type: 'string', enum: ['open', 'resolved', 'ignored'], description: 'New triage status' },
        triageNote: {
          type: 'string',
          description: 'Optional note replacing the triage note; omitted keeps the current one',
        },
      },
      required: ['clusterId', 'status'],
    },
  },
  {
    name: 'set_cluster_base_commit',
    module: 'core',
    permission: 'triage:write',
    description:
      'Pin the baseline commit SHA a cluster uses for its SCM-diff diagnosis context, so "what changed since green" is accurate. Requires `triage:write` (Maintainer and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID' },
        commit: { type: 'string', description: 'Baseline commit SHA (empty to clear)' },
      },
      required: ['clusterId', 'commit'],
    },
  },
  {
    name: 'submit_diagnosis_feedback',
    module: 'agents',
    capability: 'ai',
    permission: 'project:read',
    description:
      'Record thumbs up/down feedback on a stored diagnosis, with an optional note. Requires `project:read` (any role on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        diagnosisId: { type: 'number', description: 'Diagnosis ID' },
        feedback: { type: 'string', enum: ['up', 'down'], description: 'Rating (omit to clear)' },
        feedbackNote: { type: 'string', description: 'Optional note' },
      },
      required: ['diagnosisId'],
    },
  },
  {
    name: 'run_cluster_diagnosis',
    module: 'agents',
    capability: 'ai',
    permission: 'ai:run',
    description:
      'Trigger an AI diagnosis for a failure cluster and return the result (category, confidence, root cause, suggested fix). Returns the existing completed diagnosis unless force is set. Requires `ai:run` (Maintainer and above on the project) and a configured AI provider.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID' },
        force: { type: 'boolean', description: 'Re-run even if a completed diagnosis exists (default false)' },
        baseCommit: { type: 'string', description: 'Optional baseline commit SHA for SCM-diff context' },
      },
      required: ['clusterId'],
    },
  },
  {
    name: 'run_execution_diagnosis',
    module: 'agents',
    capability: 'ai',
    permission: 'ai:run',
    description:
      "Trigger an AI diagnosis for one failing execution (a failure), as the failure page's Diagnose does, and return the result (category, confidence, root cause, suggested fix). The execution's cluster, when it has one, grounds the diagnosis in the cluster's evidence; use run_cluster_diagnosis for the root cause a whole cluster shares. Returns the existing completed diagnosis unless force is set; refused for an execution that did not fail. Requires `ai:run` (Maintainer and above on the project) and a configured AI provider.",
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'number', description: 'Test run case ID (executionId)' },
        force: { type: 'boolean', description: 'Re-run even if a completed diagnosis exists (default false)' },
        additionalContext: { type: 'string', description: 'What you know that the evidence does not show' },
        baseCommit: { type: 'string', description: 'Optional baseline commit SHA for SCM-diff context' },
      },
      required: ['executionId'],
    },
  },
  {
    name: 'triage_cluster',
    module: 'core',
    permission: ['triage:write', 'quarantine:write'],
    description:
      "Triage one or more failure clusters at once, as the failure inbox does: set their status (open, resolved, ignored) with an optional note, assign them, snooze or unsnooze them, quarantine every test in them or release those tests from quarantine. Clusters you cannot reach or that do not exist are skipped and listed in `skippedIds`. `quarantine` and `release` report how many of the clusters' tests changed and, when their project records coverage, `uniqueCoverage`: the code only those tests run among the other non-quarantined tests. Use list_open_clusters (queue quarantine-ready, mine, regressions…) to pick them. Requires `triage:write`, or `quarantine:write` for quarantine and release (Maintainer and above on the project).",
    inputSchema: {
      type: 'object',
      properties: {
        clusterIds: { type: 'array', items: { type: 'number' }, description: 'Cluster IDs (1 to 200)' },
        action: {
          type: 'string',
          enum: ['status', 'assign', 'snooze', 'quarantine', 'release'],
          description: 'The triage action applied to every cluster',
        },
        status: {
          type: 'string',
          enum: ['open', 'resolved', 'ignored'],
          description: 'With action status: the new status',
        },
        note: { type: 'string', description: 'With action status: the triage note saved on each cluster' },
        assignee: { type: 'string', description: 'With action assign: a name or email (empty to unassign)' },
        snooze: {
          type: 'string',
          enum: ['1-day', '1-week', 'until-recurs'],
          description: 'With action snooze: how long to hide the clusters from the inbox (omit to unsnooze)',
        },
        reason: { type: 'string', description: 'With action quarantine or release: why, kept on each test' },
      },
      required: ['clusterIds', 'action'],
    },
  },
  {
    name: 'triage_gap',
    module: 'workflow',
    capability: 'test-map',
    permission: 'triage:write',
    description:
      'Give a verdict on a scenario gap, as the gap inbox does: `accept` (queue its draft, optionally for someone), `snooze` (1-day, 1-week, or until the node changes), `dismiss` with a reason (not-worth-testing, covered-elsewhere with the covering test, wrong), or `covered-by` (record the test that covers it without dismissing). A verdict counts for or against the detector that raised the gap. Pass the gap id from list_scenario_gaps. Returns the gap’s new status. Requires `triage:write` (Maintainer and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        gapId: { type: 'number', description: 'The gap id from list_scenario_gaps' },
        verb: { type: 'string', enum: ['accept', 'snooze', 'dismiss', 'covered-by'], description: 'The verdict' },
        snooze: {
          type: 'string',
          enum: ['1-day', '1-week', 'until-node-changes'],
          description: 'With snooze: how long (default 1-week)',
        },
        reason: {
          type: 'string',
          enum: ['not-worth-testing', 'covered-elsewhere', 'wrong'],
          description: 'With dismiss: why (default wrong)',
        },
        coveringTestCaseId: {
          type: 'number',
          description: 'With covered-by, or dismiss covered-elsewhere: the testCaseId of the test that covers it',
        },
        assignedTo: { type: 'string', description: 'With accept: who writes the test' },
      },
      required: ['projectId', 'gapId', 'verb'],
    },
  },
  {
    name: 'decide_merge_suggestion',
    module: 'core',
    permission: 'triage:write',
    description:
      'Approve or reject a suggestion to merge two failure clusters that look like one root cause. Approving merges them (the lower id survives, keeps its triage state and takes the other’s executions, diagnoses and occurrences; the other is deleted); rejecting leaves both as they are. Pass the clusterId of a cluster in the merge-suggestions queue of list_open_clusters, or a suggestionId from get_cluster’s mergeSuggestions; when a cluster has more than one pending suggestion, pass suggestionId. Requires `triage:write` (Maintainer and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'A cluster with a pending merge suggestion' },
        suggestionId: { type: 'number', description: 'The suggestion, when the cluster has several' },
        decision: {
          type: 'string',
          enum: ['approve', 'reject'],
          description: 'Merge the clusters, or keep them apart',
        },
      },
      required: ['decision'],
    },
  },
  {
    name: 'move_tests_to_new_cluster',
    module: 'core',
    permission: 'triage:write',
    description:
      "Move some tests out of a failure cluster into a new cluster, as the cluster page's Move to a new cluster does: for a cluster that groups failures with different root causes. The tests' executions in the cluster move to the new cluster, which gets your optional triage note; their later failures with the same error join the new cluster, and the two clusters are never merged automatically. The source cluster's triage note gains a line naming the move. Pass the testCaseIds of get_cluster's affectedTestCases. Returns the new clusterId, absent when none of the tests failed in the cluster. Requires `triage:write` (Maintainer and above on the project).",
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'The cluster to move the tests out of' },
        testCaseIds: { type: 'array', items: { type: 'number' }, description: 'The tests to move (testCaseId)' },
        triageNote: { type: 'string', description: 'Triage note of the new cluster, e.g. what sets it apart' },
      },
      required: ['clusterId', 'testCaseIds'],
    },
  },
  {
    name: 'dismiss_quarantine_proposal',
    module: 'workflow',
    capability: 'quarantine',
    permission: 'quarantine:write',
    description:
      'Dismiss what Piwi proposed for a test, as the dashboard’s Dismiss does: the proposal to quarantine it, or the proposed release of it from quarantine. `quarantine` applies to a quarantine candidate (one of the costliest flaky tests, by the CI minutes their flakiness wastes, which the flaky list marks proposed); `release` to a quarantined test whose passing streak or verified fix earned its way out (list_open_clusters with queue quarantine-ready finds their clusters). Records the proposal as rejected, with your optional reason; nothing else changes, so the test stays out of, or in, quarantine. Dismissing the same proposal again records nothing more; a dismissed quarantine proposal counts again once a newer run arrives. Fails when the test has no such proposal. Requires `quarantine:write` (Maintainer and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        testCaseId: { type: 'number', description: 'The test (testCaseId)' },
        proposal: {
          type: 'string',
          enum: ['quarantine', 'release'],
          description: 'Which proposal: quarantining the test, or releasing it from quarantine',
        },
        reason: { type: 'string', description: 'Why you dismiss it (up to 500 characters)' },
      },
      required: ['projectId', 'testCaseId', 'proposal'],
    },
  },
  {
    name: 'set_test_quarantine',
    module: 'workflow',
    capability: 'quarantine',
    permission: 'quarantine:write',
    description:
      "Quarantine one test, or release it from quarantine, as the dashboard's Quarantine and Release do. A quarantined test keeps running and reporting: quarantine only removes it from the CI gate's verdict, so its passing streak can earn it a release. Pass `quarantined: true` with an optional `reason`, or `quarantined: false` to release it (the quarantine is kept in its history). Quarantining a test already in quarantine changes nothing and keeps its streak; releasing a test not in quarantine fails. When the project records coverage, `uniqueCoverage` summarizes the code only this test runs among the other non-quarantined tests: what its quarantine leaves uncovered, or its release covers again (get_coverage_loss lists it all). Use triage_cluster to quarantine every test of a cluster. Requires `quarantine:write` (Maintainer and above on the project).",
    inputSchema: {
      type: 'object',
      properties: {
        testCaseId: { type: 'number', description: 'The test (testCaseId)' },
        quarantined: { type: 'boolean', description: 'true quarantines the test; false releases it' },
        reason: { type: 'string', description: 'Why (up to 500 characters), kept on the test' },
      },
      required: ['testCaseId', 'quarantined'],
    },
  },
  {
    name: 'set_bug_report_status',
    module: 'workflow',
    capability: 'bug-reports',
    permission: 'bug-report:write',
    description:
      'Set a bug report’s status by hand: `dismissed` (not a bug, or not worth a test), `open` (reopen it) or `closed`. The other statuses (test-committed, looks-fixed) follow the runs of the test that names the report. Requires `bug-report:write` (Contributor and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Bug report id from list_bug_reports' },
        status: { type: 'string', enum: ['open', 'dismissed', 'closed'], description: 'The new status' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'rerun_cluster_in_ci',
    module: 'core',
    capability: 'scm',
    permission: 'run:control',
    description:
      "Re-run exactly a failure cluster's affected tests in CI, as the cluster page's Re-run in CI button does: dispatches the project's configured workflow or pipeline with the project's SCM token. Returns the provider and the URL to watch the runs (the re-run's own id is not known). Fails with the reason when CI re-run is off for the project, no target or token is configured, or the cluster has no supported repository. Requires `run:control` (Maintainer and above on the project).",
    inputSchema: {
      type: 'object',
      properties: { clusterId: { type: 'number', description: 'Cluster ID' } },
      required: ['clusterId'],
    },
  },
  {
    name: 'set_cluster_bisect',
    module: 'core',
    permission: 'run:control',
    description:
      'Record the first bad commit a `git bisect` found for a failure cluster, as the desktop app does when its bisect ends: the commit then shows in the fix plan (get_fix_plan) next to the regression window. Pass the SHA (7 to 40 hex characters) and, when known, its subject, author and ISO date. Requires `run:control` (Maintainer and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID' },
        sha: { type: 'string', description: 'The first bad commit (7 to 40 hex characters)' },
        subject: { type: 'string', description: "The commit's subject line" },
        author: { type: 'string', description: "The commit's author" },
        date: { type: 'string', description: 'ISO date the commit was authored' },
      },
      required: ['clusterId', 'sha'],
    },
  },
  {
    name: 'record_diagnosis',
    module: 'agents',
    capability: 'agent-diagnoses',
    permission: 'ai:run',
    description:
      'Record the diagnosis you wrote as the current diagnosis of a failure cluster (`clusterId`) or of one failing execution (`executionId`, a failure: use it when the failure is in no cluster, or when its cause is its own), written by an agent: pass the `model` you run on and the `diagnosis` in the JSON schema Piwi asks a model for (summary; confidenceScore 0-100; severity blocker|high|medium|low; affectedArea or null; hypotheses, ranked, each with category app-bug|test-bug|flaky-test|infrastructure|environment|unknown, rootCause, likelihood 0-100 and evidence; suggestedFix with description, file, code and patch, each null when unknown; investigationSteps; preventionTips). The previous diagnosis is kept in the history. Your patch (a unified diff) is validated against the source at the commit the failure happened at when source control is connected; the answer says whether it applies. Works without an AI provider on this instance. Refused for an execution that did not fail. Returns the diagnosisId to pass to report_fix_attempt, with the clusterId of the cluster, or of the cluster the failure is in. Requires `ai:run` (Maintainer and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID (pass this or executionId)' },
        executionId: { type: 'number', description: 'Test run case ID of one failure (pass this or clusterId)' },
        model: { type: 'string', description: 'The model you run on, e.g. claude-opus-5-5' },
        diagnosis: {
          type: 'object',
          description: 'The diagnosis, in the schema Piwi asks a model for (see the description)',
        },
      },
      required: ['model', 'diagnosis'],
    },
  },
  {
    name: 'report_fix_attempt',
    module: 'core',
    permission: 'run:control',
    description:
      "Record that you changed the code to fix a failure cluster, after making the change: `kind` is patch, locator-edit or fix-plan; pass the `commit` (7 to 40 hex characters) or the `branch` the change is on, the `patch` you applied (stored as its hash) or its `patchHash`, the `edit` for a locator edit (filePath, line, from, to), and the `diagnosisId` you followed (from get_fix_plan or record_diagnosis: the cluster's diagnosis or the diagnosis of one of its failures). It is recorded as applied; when the cluster's tests pass on a later commit, Piwi records it verified (tied by the commit, a `Piwi-Cluster: <clusterId>` trailer in the commit message, or the branch) and shows it on the cluster's timeline; a later failure records it regressed. Add the trailer get_fix_plan suggests (verify.commitTrailer) to your commit message. Reporting the same change twice records it once. Requires `run:control` (Maintainer and above on the project).",
    inputSchema: {
      type: 'object',
      properties: {
        clusterId: { type: 'number', description: 'Cluster ID' },
        kind: { type: 'string', enum: ['patch', 'locator-edit', 'fix-plan'], description: 'What you changed' },
        commit: { type: 'string', description: 'The commit the change is in' },
        branch: { type: 'string', description: 'The branch the change is on, when not committed yet' },
        patch: { type: 'string', description: 'The unified diff you applied' },
        patchHash: { type: 'string', description: 'A hash of the patch, instead of the patch' },
        edit: {
          type: 'object',
          description: 'For a locator edit: the file, the line, the old and the new locator',
          properties: {
            filePath: { type: 'string' },
            line: { type: 'number' },
            from: { type: 'string' },
            to: { type: 'string' },
          },
          required: ['filePath'],
        },
        diagnosisId: { type: 'number', description: 'The diagnosis the change followed' },
        note: { type: 'string', description: 'One line on what you changed' },
      },
      required: ['clusterId', 'kind'],
    },
  },
  {
    name: 'set_run_incident',
    module: 'core',
    permission: 'project:read',
    description:
      'Mark a test run as an environment incident (its failures come from the environment under test being down, not from the tests or the code), or clear the flag, as the run page does. A flagged run is left out of baselines, fix verification, flaky scores and auto-heal, and the gate answers inconclusive for it. Pass `incident: true` with an optional `reason`, or `incident: false` to clear it. Requires `project:read` (any role on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'Test run ID' },
        incident: { type: 'boolean', description: 'true marks the run; false clears the flag' },
        reason: { type: 'string', description: 'What happened (up to 500 characters), with incident: true' },
      },
      required: ['runId', 'incident'],
    },
  },
  {
    name: 'link_issue',
    module: 'workflow',
    capability: 'integrations',
    permission: 'link:write',
    description:
      'Link an existing ticket or pull request (any http(s) URL) to a failure cluster, an execution, a test case, a run or a bug report, as the Links panel does. A URL from a connected tracker is matched to its connection and shows its live status. Use create_issue to file a new Jira issue instead. Returns the stored link. Requires `link:write` (Contributor and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: ['failure_cluster', 'test_runs_case', 'test_case', 'test_run', 'bug_report'],
          description: 'Which entity to link the URL to',
        },
        entityId: { type: 'number', description: 'The entity ID matching entityType' },
        url: { type: 'string', description: 'The ticket or pull request URL (http or https)' },
        title: { type: 'string', description: 'Optional title (at most 200 characters)' },
      },
      required: ['entityType', 'entityId', 'url'],
    },
  },
  {
    name: 'unlink_issue',
    module: 'workflow',
    capability: 'integrations',
    permission: 'link:write',
    description:
      'Remove a ticket or pull request link from a failure cluster, an execution, a test case, a run or a bug report, as the Links panel does: pass the entity and the URL link_issue took (list_links shows them). Every link of that entity to that URL is removed; the ticket itself is untouched. Fails when the entity has no link to the URL. Returns how many links were removed. Requires `link:write` (Contributor and above on the project).',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: ['failure_cluster', 'test_runs_case', 'test_case', 'test_run', 'bug_report'],
          description: 'Which entity the link is on',
        },
        entityId: { type: 'number', description: 'The entity ID matching entityType' },
        url: { type: 'string', description: 'The linked URL, as list_links returns it' },
      },
      required: ['entityType', 'entityId', 'url'],
    },
  },
  {
    name: 'create_test_function',
    module: 'workflow',
    permission: 'test-assets:write',
    description: `Register a page-object method or helper in a project's test-function catalog, so the Piwi Picker browser extension (and its recorder) can match a live page or a recorded session against it and substitute a call to your own code instead of raw locator lines. This tool does not call an AI itself — you (the calling agent) read the function's real source in your own context and fill in these fields directly; the tool only validates the shape and persists it. Follow these extraction rules when deciding the field values:\n\n${EXTRACT_SYSTEM_PROMPT}\n\nThe fields below map onto that guidance one-for-one, plus "module" and "urlPattern", which no amount of code-reading can infer — supply them from where the function actually lives and, optionally, which page it applies to. Requires \`test-assets:write\` (Maintainer and above on the project).`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        name: {
          type: 'string',
          description: 'Becomes the called method/function name — must be a valid JS identifier',
        },
        kind: {
          type: 'string',
          enum: ['page-object-method', 'helper', 'fixture'],
          description:
            '"page-object-method" for a class method acting on this.page; "helper" for a standalone function taking page as its first parameter; "fixture" only for Playwright fixture setup',
        },
        module: {
          type: 'string',
          description: "Import specifier for where this function lives, e.g. './pages/CartPage'",
        },
        receiver: {
          type: ['string', 'null'],
          description: 'page-object-method only: instance variable name, e.g. cartPage (null for a helper/fixture)',
        },
        importName: {
          type: ['string', 'null'],
          description: 'page-object-method only: the class name to import, e.g. CartPage (null for a helper/fixture)',
        },
        params: {
          type: 'array',
          description:
            "The function's own parameters, excluding the leading Playwright handle (page/locator/this). An options-bag parameter must be type 'object' with its property names in 'fields' — never flattened to a string.",
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'object'] },
              fields: {
                type: 'array',
                items: { type: 'string' },
                description: "For type 'object': the bag's property names, e.g. ['label', 'testId']",
              },
            },
            required: ['name', 'type'],
          },
        },
        returnsPage: {
          type: 'boolean',
          description: 'True if the function returns/navigates to a new Page (default false)',
        },
        urlPattern: {
          type: ['string', 'null'],
          description:
            'Optional glob (** crosses path segments, * does not, e.g. "**/cart") gating which page this applies to',
        },
        steps: {
          type: 'array',
          description: 'The ordered sequence of page interactions the function performs — at least one required',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['goto', 'click', 'fill', 'check', 'uncheck', 'selectOption', 'press', 'assertVisible'],
              },
              target: {
                type: 'object',
                properties: {
                  role: { type: ['string', 'null'] },
                  name: { type: ['string', 'null'] },
                  testId: { type: ['string', 'null'] },
                },
              },
            },
            required: ['action', 'target'],
          },
        },
        paramSources: {
          type: 'array',
          description: "Maps a step's argument back to a function parameter, when that argument IS the parameter",
          items: {
            type: 'object',
            properties: {
              param: { type: 'string' },
              path: {
                type: ['string', 'null'],
                description:
                  "For an 'object' param: which of its fields this fills (e.g. 'label'). Omit for a scalar param.",
              },
              stepIndex: { type: 'integer' },
              from: { type: 'string', enum: ['text', 'value', 'testId'] },
            },
            required: ['param', 'stepIndex', 'from'],
          },
        },
      },
      required: ['projectId', 'name', 'kind', 'module', 'params', 'steps'],
    },
  },
  {
    name: 'describe_piwi',
    module: 'core',
    description:
      'Piwi itself, from its own documentation: what it is and is not, every piece of its ecosystem, how to set it up and configure it, which option fits which need, what this instance has switched on, and where to report a bug or suggest an improvement. Call it before answering a question about Piwi rather than about test results. With no arguments it returns an overview and the list of topics: `ecosystem` (every piece — the server, desktop app, reporter and `piwi` CLI, capture fixtures, AI steps, backend instrumentation, browser and editor extensions, MCP server, agent skills, REST API, metrics export — what each is, how to get it, when you need it), `choices` (the setup decisions and their options), `features`, `configuration` (every PIWI_* variable), `mcp`, `feedback` and `docs` (the page index). The documentation ships with this server, so it matches the running version: `page` reads a page or one section ("guide/ci", "guide/ci#sharding"), and `query` searches every page and variable. What changed between versions is get_release_notes.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: Object.keys(DESCRIBE_PIWI_TOPICS),
          description: 'What to describe (default: overview)',
        },
        page: {
          type: 'string',
          description:
            'A documentation page to read, e.g. "guide/reporter", or "page#anchor" for one section; paths come from the docs index, the search hits and the `page` fields of other topics',
        },
        query: {
          type: 'string',
          description:
            'Search the documentation and the PIWI_* variables; with topic "configuration" it filters the variables instead',
        },
      },
    },
  },
  {
    name: 'get_change_coverage',
    module: 'core',
    capability: 'scm',
    description:
      'Change coverage for a pull request: the files a change touched joined to the tests that observably reach them, grouped by ticket, with the uncovered files that need a scenario. Pass a run id to diff it against its baseline, or an explicit base and head commit. Reach is observed reach, never instrumented coverage; "no test in this run" is paired with the count from recent history. Returns an empty result when no SCM token or diff is available.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        run: { type: 'number', description: 'Diff this run against its baseline (from get_project)' },
        base: { type: 'string', description: 'Base commit SHA (use with head instead of run)' },
        head: { type: 'string', description: 'Head commit SHA (use with base instead of run)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_coverage',
    module: 'core',
    capability: 'coverage',
    description:
      'Read coverage: which code ran and which tests run it (lines 1-based, ranges like `12-15,20`). With `projectId` and `file`: the file’s versions on a branch, each with its executable lines and its executed ranges grouped by the tests that ran them (positions in `tests`); add `lines` for the test running most of the function around them, the one to copy. With an execution (`executionId`, or `testCaseId` for its latest execution with coverage, or `projectId` + `testFile` + `testTitle`): its files; with `file`, that file’s ranges; with `file` and `lines`, which target lines ran, did not run or cannot be told (an incomplete capture never says "did not run"), the target lines that cannot run, and the nearest test when one did not run. Use it after running a new test with server coverage to check it reaches its target.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID: with file for the file view, or with testFile and testTitle',
        },
        file: { type: 'string', description: 'Repository-relative source path, or a path suffix' },
        lines: { type: 'string', description: 'Target lines, e.g. "57-59,63"' },
        branch: { type: 'string', description: 'File view: the branch to read (default branch when absent)' },
        executionId: { type: 'number', description: 'An execution (test run case ID)' },
        testCaseId: { type: 'number', description: 'A test: its latest execution with coverage' },
        testFile: { type: 'string', description: 'With projectId and testTitle: the test’s spec file (or a suffix)' },
        testTitle: {
          type: 'string',
          description: 'With projectId and testFile: the test’s title, without describe blocks',
        },
      },
    },
  },
  {
    name: 'compare_coverage',
    module: 'core',
    capability: 'coverage',
    description:
      'Compare the code a test ran across executions. `executionId` (a failure): the files, lines and functions it ran that the test’s last passing execution with coverage did not, and the reverse, with the baseline used (execution, run, branch, commit); a file at another version is marked changed, not compared. `testCaseId`: how its coverage varies across its last 30 executions, the code that ran in some only, and the earlier test whose having run before (in the same run, or on the same worker) predicts it, with the agreement and counts; `orderDependent` when its failures follow that code, a sign it depends on state another test leaves. Incomplete captures never yield "did not run" claims.',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'number', description: 'A failed execution to compare with its last passing one' },
        testCaseId: { type: 'number', description: 'A test whose recent executions to compare with each other' },
      },
    },
  },
  {
    name: 'get_coverage_loss',
    module: 'core',
    capability: 'coverage',
    description:
      'What quarantining, skipping or deleting tests would leave uncovered: from the latest coverage on the default branch, per file, the lines and functions no other trusted (not quarantined) test runs, those only flaky tests run besides them, and files no other test reaches. A file other tests ran only at another version is `uncertain`, never claimed. Use it before quarantining or deleting a test.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        testCaseIds: { type: 'array', items: { type: 'number' }, description: 'The tests (testCaseId), 1 to 50' },
      },
      required: ['projectId', 'testCaseIds'],
    },
  },
  {
    name: 'get_coverage_summary',
    module: 'core',
    capability: 'coverage',
    description:
      'Combined coverage of a commit: every suite that ran the code (the unit-test reports uploaded with `piwi coverage upload`, and `e2e`, the run coverage of the commit’s complete Playwright runs), counted on one set of executable lines per file version. Gives the totals and each suite’s lines (`executedLines` of `executableLines`, with `linePercent`), functions, `undeterminedLines` (unrun lines inside functions the browser suite ran, never counted as run), the lines only unit tests or only end-to-end tests run, the files without coverage data, one `folder`’s breakdown, and with `file` which suites ran each of its lines. Without `commit`, the newest commit with coverage on `branch` (default branch when absent).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        commit: { type: 'string', description: 'A commit id (7 to 64 hexadecimal characters)' },
        branch: { type: 'string', description: 'The branch whose newest commit with coverage to read' },
        folder: { type: 'string', description: 'A repository-relative folder to break down (the root when absent)' },
        file: {
          type: 'string',
          description: 'A repository-relative file: adds its lines’ classes and the lines each suite ran',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_scenario_gaps',
    module: 'workflow',
    capability: 'test-map',
    description:
      'Ranked scenario gaps for a project: tests that do not exist yet, each with its class (blind-spot, false-comfort, fragile), evidence lines and exposure score. Filter by class, feature, a minimum score, or a pull-request number. Every line is observed reach, never instrumented coverage. Pair with draft_scenario to turn a gap into a test skeleton.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        class: {
          type: 'string',
          description: 'Filter by gap class: blind-spot | false-comfort | fragile | unhandled | degraded',
        },
        feature: { type: 'string', description: 'Filter to a feature (the piwi:feature tag)' },
        minScore: { type: 'number', description: 'Only gaps at or above this exposure score' },
        pr: { type: 'number', description: 'Only gaps reported on this pull request' },
        limit: { type: 'number', description: 'Max gaps to return (default 20)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'draft_scenario',
    module: 'workflow',
    capability: 'test-map',
    description:
      'A deterministic test skeleton for a scenario gap: a title from the gap, piwi: annotations from the nearest test, the graph path from a reached page to the gap as the step list, catalog page-object methods where they match, and a TODO assertion naming what to check. Delivered as text to paste or hand to an agent — nothing is committed. Pass the gap id from list_scenario_gaps.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        gapId: { type: 'number', description: 'The gap id from list_scenario_gaps' },
      },
      required: ['projectId', 'gapId'],
    },
  },
  {
    name: 'get_feature_graph',
    module: 'workflow',
    capability: 'test-map',
    description:
      'The feature-graph neighborhood around a node: walk the typed graph (tests, pages, controls, routes, handlers, dependencies) outward from `node` to `depth` hops (capped at six), returning each node with its gap class and the tests that reach it, and the edges between them. Use it to see the blast radius of a change or what a test protects. `node` is "kind:key", e.g. route:POST /api/orders.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        node: { type: 'string', description: 'Seed node as kind:key, e.g. route:POST /api/orders or page:/checkout' },
        depth: { type: 'number', description: 'Hops to walk outward (default 2, max 6)' },
      },
      required: ['projectId', 'node'],
    },
  },
  {
    name: 'get_quality_report',
    module: 'workflow',
    capability: 'quality-reports',
    description:
      'A quality report as its bundle: a built-in dashboard (executive: a rule-based verdict, headline numbers, the pass-rate trend, what changed, what is being done and the risks; engineering adds flaky tests, clusters, CI time, detail and scenario gaps; team is engineering for one owner and needs `owners`; gaps-digest is the Test Map’s weekly digest; overview is the analytics page) rendered over a scope, every string already formatted. Use it to answer "how did the checkout suite do this week" or to post a summary. Numbers never come from a model: the verdict is built by rules.',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard: {
          type: 'string',
          enum: ['executive', 'engineering', 'team', 'gaps-digest', 'overview'],
          description: 'Built-in dashboard (default executive)',
        },
        lang: {
          type: 'string',
          enum: [...REPORT_LANGUAGES],
          description:
            'Report language (default: the project’s ticket language, else the instance locale, else English)',
        },
        ...ANALYTICS_SCOPE_PROPERTIES,
      },
    },
  },
  {
    name: 'get_release_notes',
    module: 'core',
    description:
      'What changed in each Piwi release, from the changelog shipped with this server — so it ends at the running version; newer releases are on GitHub. With no arguments: the running version\'s notes and the ten most recent releases. `version` ("0.36.0", or "0.36" for every release of a minor) returns releases in full: highlights, breaking changes, features and fixes. `since` summarizes every release after a version with its breaking changes listed first — the upgrade question. `query` finds the entries that mention every term (which release added share links?), within `version` or `since` when given.',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'A release such as "0.36.0", or a minor such as "0.36"' },
        since: { type: 'string', description: 'List the releases after this version, e.g. "0.30.0"' },
        query: { type: 'string', description: 'Only the entries that mention every term' },
      },
    },
  },
  {
    name: 'get_metric_trend',
    module: 'core',
    description:
      'One metric from the metric catalog over a scope: its value and change against the comparison period, its definition, and its series bucketed over the period with the comparison period aligned bucket for bucket. Metrics: test-pass-rate, run-success-rate, runs, suite-size, flaky-occurrences, flaky-tests, wasted-ci-minutes, wasted-ci-cost, ci-time, new-regressions, newly-flaky, average-run-duration, average-p90-test-duration, open-failure-causes, failure-causes-opened, failure-causes-fixed, median-time-to-fix, oldest-open-failure-cause, fixes-that-held, quarantine-debt, and the hand-back metrics heal-adoption, heal-pr-merge-rate, diagnosis-helpful-rate, diagnosis-verified-rate, gate-blocked-merges, gate-overrides, flakes-verified-fixed (a rate is null with a `sample` under its floor until enough items count; a metric whose capability is declined is refused).',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric id from the catalog, e.g. test-pass-rate' },
        by: {
          type: 'string',
          enum: ['auto', 'day', 'week', 'month'],
          description: 'Bucket size (default auto, about 31 buckets)',
        },
        ...ANALYTICS_SCOPE_PROPERTIES,
      },
      required: ['metric'],
    },
  },
  {
    name: 'list_dashboards',
    module: 'core',
    description:
      'Every dashboard you can open: the built-in ones (overview is the analytics page; executive, engineering and gaps-digest are the report dashboards) and the saved dashboards shared with everyone or yours, each with its id, name, description, owner, visibility and widget count. Pass an id to get_dashboard.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_dashboard',
    module: 'core',
    description:
      'One dashboard with every widget’s data, the JSON the page renders, band by band. Use it to answer "how did the checkout dashboard do this sprint". The scope is the dashboard’s own: a scope key you pass (period, projectIds, …) replaces that key only, and the others keep the dashboard’s values, so a period alone keeps its projects and filters; each widget’s own period or narrower filters still apply. A dashboard grants no access: widgets are computed for your projects only, and `hiddenProjects` counts the ones of its scope you cannot open.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'A built-in dashboard key (overview, executive, …) or a saved dashboard id',
        },
        by: {
          type: 'string',
          enum: ['auto', 'day', 'week', 'month'],
          description: 'Bucket size of the series (default: the dashboard’s)',
        },
        ...ANALYTICS_SCOPE_PROPERTIES,
      },
      required: ['id'],
    },
  },
  {
    name: 'compare_periods',
    module: 'core',
    description:
      'The headline metrics of one scope over two periods chosen freely, e.g. this sprint against the last one, or August against July: each metric over `a`, with `b` as its previous value and the change. `a` and `b` use the period syntax of the other tools (last-7d, last-month, 2026-08-01..2026-08-31, release-1, …).',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'The period to report on' },
        b: { type: 'string', description: 'The period to compare it with' },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metric ids (default: the six headline metrics)',
        },
        ...ANALYTICS_SCOPE_PROPERTIES,
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'list_bug_reports',
    module: 'workflow',
    capability: 'bug-reports',
    description:
      'A project’s bug reports, newest first: bugs reported from Piwi Picker with their steps, the expected result and evidence. Each item has its status (open, test-committed, looks-fixed, closed, dismissed), page, reporter, the test that reproduces it once committed (testCaseId) and how many reproductions were recorded. Use get_bug_report for the steps and evidence of one.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID from list_projects' },
        status: {
          type: 'string',
          enum: ['open', 'test-committed', 'looks-fixed', 'closed', 'dismissed'],
          description: 'Keep one status',
        },
        pageSize: { type: 'number', description: 'Items per page (1-50, default 10)' },
        cursor: { type: 'string', description: 'nextCursor from the previous page' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_bug_report',
    module: 'workflow',
    capability: 'bug-reports',
    description:
      'One bug report: its steps in words, each expected assertion with the value the page showed instead, the steps document itself (to replay or render), the evidence (console errors, failed requests with their status, the page outline), the reproductions recorded since, and the test that reproduces it. Use render_steps with its id to get the failing test to commit.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Bug report id from list_bug_reports' } },
      required: ['id'],
    },
  },
  {
    name: 'render_steps',
    module: 'workflow',
    capability: 'bug-reports',
    description:
      'Render a steps document as a Playwright spec with the converter every Piwi surface uses. Pass `bugReportId` for a report’s spec with the project’s generated-spec settings, function catalog and suite locators (`mode` commit, the default: `test.fail()`, `@bug` and `piwi:bug`, to commit now; run: without `test.fail()`, to reproduce), or `steps` (a steps document, as Piwi Picker’s Download steps writes it) with converter options. Returns { code, path, warnings }.',
    inputSchema: {
      type: 'object',
      properties: {
        bugReportId: { type: 'number', description: 'Bug report id; takes precedence over steps' },
        mode: { type: 'string', enum: ['commit', 'run'], description: 'For a bug report (default commit)' },
        steps: { type: 'object', description: 'A steps document ({ v: 1, origin, steps, … })' },
        options: {
          type: 'object',
          description:
            'Converter options for `steps`: title, testImport, urls (absolute|relative), locators (first|stable), urlChecks, values (literal|env), expectFail, tags',
        },
      },
    },
  },
] as const satisfies readonly McpToolDef[];

/**
 * Union of every tool name in the catalog, derived from the array above so it
 * can never drift. Used to type the server's handler map (`Record<McpToolName,
 * …>`), which makes a missing or extra handler a compile-time error.
 */
export type McpToolName = (typeof MCP_TOOL_DEFS)[number]['name'];

/**
 * Desktop-only tools — served **only** by the desktop app's bundled server (the
 * one launched with `PIWI_DESKTOP_TOKEN`), never by a hosted/Docker/npx server.
 *
 * They exist because the desktop server runs on the developer's own machine,
 * next to the checkout and the CI artifacts — reach a hosted instance simply
 * does not have. The route (`server/routes/mcp.post.ts`) appends these to
 * `tools/list` and accepts them in `tools/call` only in desktop mode; every
 * handler also re-checks the desktop token, so they can never be reached on a
 * server build.
 *
 * Kept in a separate catalog from `MCP_TOOL_DEFS` so the documented "N tools"
 * count and the hosted surface are unchanged — the desktop server advertises
 * the full catalog plus these.
 */
export const DESKTOP_MCP_TOOL_DEFS = [
  {
    name: 'import_local_report',
    module: 'core',
    permission: 'storage:manage',
    description:
      'Desktop app only. Import a Playwright blob report or trace .zip straight from a path on THIS machine into a Piwi project — the local server reads the file itself, nothing is uploaded. Use after a local or CI run to pull its results in for analysis (a hosted Piwi cannot read your disk). Idempotent by content hash: re-importing the same archive is a no-op. Returns the created/updated run. Requires `storage:manage` (administrators only).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a blob report or trace .zip on this machine' },
        projectName: { type: 'string', description: 'Piwi project to import into (created if it does not exist)' },
        environment: { type: 'string', description: 'Optional environment label for the imported run' },
        label: { type: 'string', description: 'Optional run label' },
      },
      required: ['path', 'projectName'],
    },
  },
  {
    name: 'read_local_source',
    module: 'core',
    description:
      'Desktop app only. Read a source file from THIS machine — the current on-disk code, not the snippet Piwi captured at failure time, so you can fix against the real file. Pass a line to get a window around it (default ±40 lines); omit it to read the whole file (capped at ~256 KB). Returns the path, the 1-based line range and the text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file on this machine' },
        line: {
          type: 'number',
          description: '1-based line to center the window on (omit to read the whole file)',
        },
        contextLines: { type: 'number', description: 'Lines of context on each side of `line` (default 40, max 500)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'apply_locator_fix',
    module: 'healing',
    capability: 'locator-healing',
    description:
      "Desktop app only. Apply Piwi's recommended locator fix for a failing execution to the file on THIS machine. Resolves the healing recommendation for executionId, finds the failing line under repoRoot, and rewrites just that one locator call. Previews by default (apply=false): returns the file, line, the old and new line, and a unified diff, changing nothing. Set apply=true to write it. Refuses when the on-disk line no longer matches what Piwi recorded (the file drifted) and hands back the diff so you can place it by hand.",
    inputSchema: {
      type: 'object',
      properties: {
        executionId: {
          type: 'number',
          description: 'Test run case ID (executionId from get_run.cases / explain_failure)',
        },
        repoRoot: {
          type: 'string',
          description: 'Absolute path to the checkout root the failing test file lives under',
        },
        apply: { type: 'boolean', description: 'Write the change (default false — preview only)' },
      },
      required: ['executionId', 'repoRoot'],
    },
  },
] as const satisfies readonly McpToolDef[];

/** Union of every desktop-only tool name — types the desktop handler map. */
export type DesktopMcpToolName = (typeof DESKTOP_MCP_TOOL_DEFS)[number]['name'];

// ── Tool output item types ────────────────────────────────────────────────────
//
// Fields are optional when `dropNulls` may strip them at runtime (null / '' /
// [] values are omitted from the JSON). These are the shapes agents receive, not
// the shapes the DB queries return.

/** Flaky test item returned by list_flaky_tests. */
export interface McpFlakyTestItem {
  testCaseId: number;
  title: string;
  filePath: string;
  /** Tags declared on the test, `@` stripped. */
  tags?: string[];
  /** Owner declared via the `piwi:owner` annotation. */
  owner?: string;
  priority?: string;
  flakyScore: number;
  failureRate?: number;
  runCount: number;
  failCount?: number;
  retryPassCount?: number;
  alternationCount?: number;
  rootCause?: string;
  impact?: number;
  wastedCiMinutes?: number;
  avgFailedDurationMs?: number;
}

/** Affected test case in get_cluster.affectedTestCases. */
export interface McpAffectedTestCase {
  testCaseId: number;
  title: string;
  filePath: string;
  runCount: number;
  executionId?: number;
}
