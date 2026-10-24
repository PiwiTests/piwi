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
import { EXTRACT_RULES } from './test-function-extract-prompt';
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

/**
 * A tool description in Markdown, one block per argument: a string is a
 * paragraph, a list of strings a bulleted list under the paragraph before it.
 * The first paragraph is the tool's one-sentence summary (`toolSummary`).
 */
function md(...blocks: readonly (string | readonly string[])[]): string {
  return blocks
    .map((block, i) => {
      if (typeof block === 'string') return i === 0 ? block : `\n\n${block}`;
      return `\n${block.map((item) => `- ${item}`).join('\n')}`;
    })
    .join('')
    .trim();
}

/** The first paragraph of a tool's description: its one-sentence summary. */
export function toolSummary(description: string): string {
  return description.split('\n\n')[0]!.trim();
}

/** A tool's description after its summary, in Markdown; empty when the summary is all of it. */
export function toolDetails(description: string): string {
  const at = description.indexOf('\n\n');
  return at === -1 ? '' : description.slice(at + 2).trim();
}

/** One top-level argument of a tool, as the `/mcp` page lists it. */
export interface McpToolParameter {
  name: string;
  /** The JSON Schema type, e.g. `number`, `string or null`, `number[]`. */
  type: string;
  required: boolean;
  description: string;
  /** The values an `enum` (or an array's item `enum`) allows. */
  values: readonly string[];
}

interface SchemaProperty {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly unknown[];
  items?: { type?: string | readonly string[]; enum?: readonly unknown[] };
}

function schemaType(type: string | readonly string[] | undefined): string {
  if (type === undefined) return 'any';
  return typeof type === 'string' ? type : type.join(' or ');
}

/** A tool's top-level arguments, in the order its input schema declares them. */
export function toolParameters(tool: Pick<McpToolDef, 'inputSchema'>): McpToolParameter[] {
  const required = new Set(tool.inputSchema.required ?? []);
  return Object.entries(tool.inputSchema.properties).map(([name, raw]) => {
    const property = raw as SchemaProperty;
    const type = property.type === 'array' ? `${schemaType(property.items?.type)}[]` : schemaType(property.type);
    return {
      name,
      type,
      required: required.has(name),
      description: property.description ?? '',
      values: (property.enum ?? property.items?.enum ?? []).map(String),
    };
  });
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
    description: md(
      'List the projects you can read, with their run and test-case counts and their latest run.',
      'Start here: most tools take a project’s `id` as `projectId`.',
    ),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project',
    module: 'core',
    description: 'Get one project with its recent runs and their pass and fail counts, newest first.',
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
    description: 'List a project’s test runs, newest first, optionally filtered by status or branch.',
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
    description: md(
      'Get a test run’s summary and its test cases (by default only the failed ones), each with its status, truncated error and failure cluster.',
      'A case’s `executionId` is what `explain_failure` and the other execution tools take.',
    ),
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
      'List a project’s failed and timed-out executions across recent runs, each with a one-line headline ahead of its truncated error.',
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
    description: md(
      'List a project’s flaky tests, highest flakiness score first.',
      'A test whose Flake Lab verify experiment held is left out until it passes on retry again.',
    ),
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
    description: md(
      'Get a test case with its pass and fail stats, its flakiness metrics and its recent executions.',
      'Takes the stable `testCaseId`, not a per-run `executionId`.',
    ),
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
    description: md(
      'List a project’s failure clusters, each grouping the failures that share an error fingerprint.',
      'For the cross-project triage queue, use `list_open_clusters`.',
    ),
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
    description: md(
      'Get a failure cluster with its affected tests, a short diagnosis summary and the locator fixes of up to five of its failures.',
      'Each locator fix names the failing locator, the recommended replacement and how many alternatives exist. `mergeSuggestions` lists the pending suggestions to merge it with another cluster (`suggestionId`, `otherClusterId`), decided with `decide_merge_suggestion`.',
      'To fix the cluster, `get_fix_plan` has everything in one answer; `get_cluster_diagnosis` has the full diagnosis and `get_cluster_context` the raw evidence.',
    ),
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
    description: md(
      'Get everything needed to fix one failure cluster, in one answer.',
      'Prefer it over assembling `get_cluster`, `get_cluster_diagnosis` and `get_locator_healing` yourself. It carries:',
      [
        'the diagnosis and its validated patch',
        'ranked locator replacements, each with its file and line and a ready-to-apply `edit`: the rewritten line plus a unified diff `git apply` accepts',
        'the failing tests and the owning team',
        '`suspectLines`: the top five changed lines since the last green run that the failing tests executed, with their files, line ranges and scores, so you know where to look first (`available: false` with a `reason` when the tests recorded no coverage or the diff could not be read)',
        '`verify`: the `command` that runs exactly the failing tests, the `expectation` (what the dashboard records once they pass, so you can confirm the fix landed) and the `commitTrailer` to put in your commit message',
        '`reproduce`: checkout, pinned install, browser install and the exact test command, as `{ bash, powershell }` steps',
        '`bisect`: a `git bisect` script between the last green and the failing commit (`available: false` with a `reason` when there is none)',
        '`story`, `situation` (since when, whether a newer execution failed again or passed, the cluster and its owner) and the computed `nextStep`',
      ],
    ),
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
    description: md(
      'Get the stored diagnosis of a failure cluster: category, confidence, root cause, evidence and suggested fix.',
      'Piwi’s AI writes it (`run_cluster_diagnosis`), or an agent does (`record_diagnosis`). Returns null when the cluster has no diagnosis yet.',
    ),
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
    description: md(
      'Get the stored diagnosis of one failing execution, in the shape `get_cluster_diagnosis` returns.',
      'Piwi’s AI writes it (`run_execution_diagnosis`), or an agent does (`record_diagnosis` with `executionId`). Returns null when the execution has none: a failure in a cluster usually shares the cluster’s diagnosis (`get_cluster_diagnosis`).',
    ),
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
    description: md(
      'Get the evidence Piwi’s AI reads for one failing execution: steps, console, network, backend logs and the source-control diff.',
      'Use it when debugging a single failure. For a failure in no cluster, it returns the stored evidence instead (`rawExecution`).',
    ),
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
    description: md(
      'List an execution’s screenshots, the page the test failed on first, and return the image data of the first three on request.',
      'By default it returns metadata only (file name, media type, size) for every screenshot. Call it that way first, then set `content: true` to get the first three only, with their base64 image data (each capped at about 100 KB).',
      'The screenshot of the page the test failed on comes first, flagged `atFailure`, when it is known: the capture fixtures’ screenshot of the page the test last acted on, or the only screenshot. Without the fixtures, Playwright takes one per page still open at the failure and one per page of each context the test closed before, so none of several is flagged.',
    ),
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
    description: md(
      'Get the full evidence of a failure cluster, the same the diagnosis AI reads: the richest evidence there is for debugging a failure.',
      'It holds error samples, stack traces, test steps, console logs, network failures, ARIA snapshots and the source-control diff (the files changed since the last green run), with a block saying which sections are present, truncated or absent. `coverage` says what the diff covers (commit range, files, patches left out).',
    ),
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
    description: md(
      'Find a project’s test cases by title, file path or external ID, when you don’t know their `testCaseId`.',
      'An external ID, the one a test has in the team’s test management tool, matches whole. Each match has its `id` (the `testCaseId`), title, file path, external ID, tags and locks.',
    ),
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
    description: md(
      'Get one execution in full: a one-line failure headline, the untruncated error, steps, console logs, web vitals and the ARIA snapshot.',
      '`include` fetches only the heavy parts you need; the error, status and summary always come back. For a failure, `explain_failure` adds the locator fix, the diagnosis context and the situation, with a shorter error and ARIA snapshot.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        executionId: {
          type: 'number',
          description: 'Test run case ID (executionId from get_run.cases or get_cluster.affectedTestCases)',
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
    description: md(
      'List the most recent test runs across every project you can read, newest first.',
      'Takes no `projectId`: it is the cross-project view of recent CI activity.',
    ),
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
    description: md(
      'List the recent commits of a project’s repository, with their SHA, message, author and date.',
      'Needs a source-control token, set on the project or for the instance.',
    ),
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
    description: md(
      'Get the changed files and patches of one commit in a project’s repository.',
      'Use it on a commit suspected of causing a failure. Needs a source-control token, set on the project or for the instance.',
    ),
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
    description: md(
      'Compare a run with its baseline, to answer what changed and whether a fix worked.',
      'It returns the pass-rate delta, new regressions, recurrences, recovered tests, new flaky tests, the biggest performance improvements and regressions, worker imbalance and newly opened clusters.',
      'The baseline is the last passing run in the same environment, on the same branch, else the branch it forked from, else any branch; when no earlier full run passed, it is the last failed run, found the same way. `baseline` says why it was chosen.',
    ),
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
    description: md(
      'Get the health of each area of a project’s suite over the last N days, grouped by spec-file prefix.',
      'Each area has its pass rate, flaky rate, failure count, execution count (`testCount`) and average duration. Use it to find the unhealthy parts of a suite.',
    ),
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
    description: md(
      'List a project’s slowest tests by average duration, with their maximum, minimum and trend across recent runs.',
      'Use it to target performance work.',
    ),
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
    description: md(
      'Get a project’s run duration, average test duration and p90 test duration over its recent runs.',
      'Use it to answer whether the suite is getting slower.',
    ),
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
    description: md(
      'Get one test’s flaky rate, pass rate and average duration over the last N days, in about 31 UTC time buckets.',
      'Use it to answer whether a test is getting flakier.',
    ),
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
    description: md(
      'Get the suspects of a flaky test from its last 30 days (at most 200 attempts), and the Flake Lab experiments run on it.',
      'Use it before changing a flaky test, to know what to reproduce and whether a fix was verified.',
      'A suspect is something its failures share and its passes do not: a slow or failed route, a test running alongside it or just before it on the same worker, the load, or the browser project. There are at most five; each needs 3 failures and a lift of 2, and has:',
      [
        'its raw counts (`failuresWith` of the failures, `passesWith` of the passes) and its lift',
        'the condition that would test it: delay or fail a route, throttle the CPU, run another test alongside or first, pin a project',
        '`lab`: its latest arm result',
        'for a test running alongside: the paths both tests write, and whether the overlap crossed shards (approximate)',
      ],
      '`context` holds the factors no condition tests (first attempt, UTC hour, another run on the environment). `experiments` lists the test’s latest finished `piwi flake` experiments, at most 10, newest first: kind (reproduce or verify), verdict, the commit it ran and the commit of the failures, and each arm with its conditions, runs, matching failures (same error as history), other failures, p-value against the control and verdict.',
    ),
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
    description: md(
      'Get the Flake Lab plan for a flaky test, for an agent that runs the lab itself.',
      'It records nothing: the command records the experiment when it runs. The plan has:',
      [
        'the `piwi flake` and `piwi flake verify` commands, to run from the project root',
        'the control arm and one arm per suspect, most likely first, with the conditions each applies (delay or fail a route, throttle the CPU, run another test alongside or first, pin a project)',
        'the runs, the early stop and the error signatures a failure must match',
        'an estimate from the test’s median duration',
        '`plan`: the full plan, which `piwi flake --plan <file>` also runs without the dashboard',
      ],
      'After a fix, run the verify command: exit code 0 means the fix held under the condition that reproduced the failure.',
    ),
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
    description: md(
      'Get a run’s network requests grouped by method and normalized route, slowest first.',
      'Each route has its request count, average, p90 and maximum duration, error rate and the tests that called it. Use it to pin a UI failure on a slow or failing endpoint; the backend logs of one failing test are in `explain_failure` and `get_test_case_context`.',
    ),
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
    description: md(
      'List what a project’s tests leave open or let grow, across runs, most recently seen first.',
      'Use it before touching a suite’s fixtures or teardown, or to check that a leak fix held. Each finding has a verdict:',
      [
        '`leaked`: a browser, context, page or API context left open past the test or describe block that opened it',
        '`idle`: a page opened and never used',
        '`piling`: pages, listeners or route handlers growing on a long-lived page',
        '`handle`: a Node server or file watcher a test left running in its worker',
        '`probable`: a leak counted from steps, without the capture fixtures',
      ],
      'Each finding also has `site` (the `file:line` that opened it, the line to edit), the runs it was first and last seen in, how many runs showed it, and `last`: what it held the last time (objects, tests, how long it stayed open, page CPU after its test). Its status is `open`, or `fixed` once five full runs of the default branch came without it (`cleanRuns` counts them; `reopenedRunId` is set when a fixed one came back).',
    ),
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
    description: md(
      'Get what one run cost and left open, from its reporters’ resource reports (one per shard).',
      'Use it to explain a slow or timing-out run, or to find which tests a leak slows down. It returns:',
      [
        'the findings, each with `isNew`: true when its base branch (the pull request’s target, else the default branch) had not shown it before',
        'each shard’s machine: cores, memory, how busy its CPUs were, the share of time a task waited for a CPU, CPU time by process role, peak memory and the largest process, disk',
        'the busiest open pages per worker',
        'the costliest tests by the CPU of their worker and browser processes, with the pages each found already open',
      ],
      'A null field was not measured on that platform.',
    ),
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: 'Test run ID' } },
      required: ['runId'],
    },
  },
  {
    name: 'get_failure_groups',
    module: 'core',
    description: md(
      'Get one run’s failures grouped by failure cluster, with each group’s affected tests and worker correlation.',
      'The run-scoped counterpart of `list_clusters`.',
    ),
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
    description: md(
      'Get ranked replacements for a failing execution’s broken locator, with a ready-to-apply edit.',
      'Use it when fixing a broken selector. It returns the failing locator, the recommended durable fix and up to eight alternatives from each source (a rename in the source diff, a prior success, an element match, the ARIA snapshot), with `location` (`file:line:col`), the failing `sourceLine` and `edit`: the rewritten line plus a unified diff `git apply` accepts.',
      'It returns `{ applicable: false, reason }` when the locator resolved and the failure came after it, or the error is a navigation error: do not rewrite the selector then.',
    ),
    inputSchema: {
      type: 'object',
      properties: { executionId: { type: 'number', description: 'Test run case ID (executionId)' } },
      required: ['executionId'],
    },
  },
  {
    name: 'predict_locator_breaks',
    module: 'healing',
    description: md(
      'Predict which of a project’s test locators a change breaks, before any test runs.',
      'Run it after a UI change, apply its edits, then run the tests it names. Send your working diff (`git diff` output): the strings it removes or renames (attribute values such as an `aria-label`, a placeholder or a test id, text between tags, quoted strings, translation values) are matched against every locator chain the project’s tests used, under Playwright’s text rules (case-insensitive substring unless exact, regex as written). Test files in the diff are ignored. Each break has:',
      [
        'its confidence: `likely` for an attribute, tag text or translation, `possible` for a bare string',
        'the tests and their call sites (`file:line:col`, relative to where the reporter ran)',
        'for a one-to-one rename, `rewrite` (the same chain with the new string) and `edits`: replace each `before` string literal with `after` at the call sites',
      ],
    ),
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
    description: md(
      'Search every project you can read for projects, runs, test cases and failure clusters.',
      'Projects match by name or label, runs by label or numeric id, test cases by title, and clusters by title, signature, `#id` or the key of a linked issue such as PROJ-123. Use it to find a run by its label, the cluster a ticket tracks, or an entity whose project you don’t know.',
    ),
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Search query (min 2 chars)' } },
      required: ['q'],
    },
  },
  {
    name: 'list_case_traces',
    module: 'core',
    description: md(
      'List an execution’s Playwright trace files, each with its download path.',
      'Fetch a trace’s bytes with `GET /api/files/<path>`.',
    ),
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
      'List the tickets and pull requests linked to a run, an execution, a test case or a failure cluster, with their provider and unfurled status.',
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
    description: md(
      'File a Jira issue for a failure cluster, a failing execution or a bug report, with the fix plan as its body.',
      'It is the ticket the dashboard’s **Create issue** button files. Issues are deduplicated by cluster: a second call for the same cluster returns the existing one rather than filing another. Returns the issue (`key`, `url`) and the `existing` issues that already track the cluster (a pinned link, a matching label or a fixed-before match), so you can link one instead of filing again.',
      'Needs a Jira connection and a project binding (project key and issue type). The binding’s field defaults fill the fields the Jira project requires, and `fields` sets the others.',
      'Requires `issue:create` (Contributor and above on the project).',
    ),
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
    description: md(
      'List every tag defined on this instance, with its id, text and color.',
      'Tags are instance-wide, not per project.',
    ),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project_test_catalog',
    module: 'workflow',
    description: md(
      'List a project’s whole test catalog, with each test’s pass, fail and flaky counts, average duration and last status.',
      'The bulk companion of `get_test_case`; it pages by `offset`, not by cursor.',
    ),
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
    description: md(
      'List a project’s saved test selections and the built-in ones (`failed`, `quarantine-free`).',
      'A selection is a named, declarative subset of the suite, resolved from run history. `resolve_selection` turns one into the tests to run.',
    ),
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'number', description: 'Project ID from list_projects' } },
      required: ['projectId'],
    },
  },
  {
    name: 'resolve_selection',
    module: 'workflow',
    description: md(
      'Resolve a saved or built-in selection to the tests it matches now, with a ready-to-run `playwright test` command.',
      'After a fix, resolve the selection that covers it for the exact command that verifies it.',
    ),
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
    description: md(
      'Resolve a selection definition without saving it, the dry run behind the selection builder.',
      'Send a definition (include and exclude predicate groups, pins, budget, limit) to get the matching tests, an estimate, warnings and a command. An unknown predicate is an error, never ignored.',
    ),
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
    description: md(
      'Suggest tags and a smoke suite for a project from its run history, each with its evidence; nothing is saved.',
      'It returns:',
      [
        '`slow` tags for duration outliers',
        '`feature` tags from the route families tests hit',
        'a mined smoke suite: a set cover over observed routes within `budgetMs` (default 5 minutes), each pick adding fewer new routes than the one before',
      ],
      'The smoke suite lists its `splitLocks` (locks held by more than one pick), which plain `playwright test --shard` could split across shards: run it with the lock-aware `piwi run --shard` instead.',
    ),
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
    description: md(
      'Check the health and drift of a project’s selections, read-only.',
      'For each selection: what it resolves to now (count, quarantined members, duration, warnings) and whether that differs from what its last stamped run recorded, a drift a green build can hide. A `split-lock` warning means a lock is shared by more than one test, which Playwright’s own `--shard` could split across shards.',
      'It also counts the tests no stored selection matches (the unselected gap), with a sample.',
    ),
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'number', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'get_impacted_tests',
    module: 'workflow',
    description: md(
      'Get the tests a change impacts, the ones to run and the first to check for updates, before any test runs, with a ready `playwright test` command.',
      'Send your working diff (`git diff --full-index <base>`, where the base is the commit the change starts from), or `changedFiles` for file-level impact only. Each changed file selects:',
      [
        'the tests defined in it (`test-file`)',
        'the tests that failed inside it (`frames`)',
        'the tests that called a route it handles (`route`)',
        'the tests whose coverage reaches it',
      ],
      'With recorded coverage of a modified file’s base version, its coverage-reached tests narrow to those that ran a changed line (`lines`) or a function around one (`functions`). A test its coverage cannot rule out stays (`file`): another version, no ranges, an incomplete capture, or a change outside every function, listed in `fileLevelLines`.',
      'Each file gives its `level` (`lines`, `file` or `none`), its tests with how they were selected and the changed lines they ran (1-based, `12-15,20`), `ruledOut` (how many tests reach it and ran none of the changed lines) and `notRun` (changed lines inside functions no test ran: what a new test should cover, see the `write_the_missing_test` prompt). A changed file that maps to no test widens the selection to the whole suite (`widened`, with a warning) rather than skipping it.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Project ID' },
        diff: {
          type: 'string',
          description:
            'The change as a unified diff (`git diff --full-index <base>` output); its `index` lines name each base version',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repository-relative paths of the changed files, instead of diff (file level only)',
        },
        format: {
          type: 'string',
          enum: ['args', 'grep', 'files', 'json'],
          description: 'Command materialization (default args)',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_open_clusters',
    module: 'core',
    description: md(
      'List the failure clusters of every project you can read, open ones by default, most occurrences first: a cross-project triage queue.',
      '`queue` focuses one queue of the failure inbox: `regressions` on the default branch, `fix-didnt-hold`, `quarantine-ready`, `merge-suggestions` awaiting a decision, `needs-ticket`, or `mine` (assigned to you or owned by you). A queue keeps open, non-snoozed clusters and overrides `status`; without one, snoozed clusters are listed too.',
    ),
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
    description: md(
      'Get instance-wide counts (projects, runs, test cases, executions, files) and the total storage size.',
      'Requires `storage:manage` (administrators only).',
    ),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'explain_failure',
    module: 'core',
    description: md(
      'Explain one failing execution in one call: its evidence, its situation and the next step.',
      'Prefer it over chaining `get_test_run_case`, `get_locator_healing` and `get_test_case_context`. It carries:',
      [
        'a one-line headline; for a test that passed on retry, the headline of its failed attempt, named in `failedAttempt` by its `executionId` and retry index (0 for the first attempt) to call this tool on',
        'the error, steps, console and ARIA snapshot',
        'the recommended locator fix, the structural page diff against the last green sample and a screenshot count',
        'the AI diagnosis context',
        '`story`: the clues chained into one sentence, when a known combination matches',
        '`situation`: since when, on which commit, whether a newer execution of the test failed again or passed, in how many tests, and who owns it',
        '`didNotRun`: why a test that did not run never started, in one sentence',
        '`latest`: whether this is the test’s latest execution in its Playwright project, else the `executionId`, `runId` and status of the newest one',
        '`nextStep`: the computed next step',
      ],
    ),
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
    description: md(
      'Set a failure cluster’s triage status to open, resolved or ignored, with an optional note.',
      'Use it after fixing the underlying issue; `triage_cluster` triages several clusters at once.',
      'Requires `triage:write` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Pin the baseline commit of a failure cluster’s source-control diff, so its evidence of what changed since green is accurate.',
      'An empty `commit` clears it.',
      'Requires `triage:write` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Rate a stored diagnosis thumbs up or down, with an optional note.',
      'Omit `feedback` to clear the rating.',
      'Requires `project:read` (any role on the project).',
    ),
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
    description: md(
      'Run Piwi’s AI diagnosis of a failure cluster and return it: category, confidence, root cause and suggested fix.',
      'Returns the existing completed diagnosis unless `force` is set. Needs an AI provider configured on this instance.',
      'Requires `ai:run` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Run Piwi’s AI diagnosis of one failing execution, as the failure page’s **Diagnose** does, and return it: category, confidence, root cause and suggested fix.',
      'When the execution is in a cluster, the cluster’s evidence grounds the diagnosis; use `run_cluster_diagnosis` for the root cause a whole cluster shares. Returns the existing completed diagnosis unless `force` is set, and refuses an execution that did not fail. Needs an AI provider configured on this instance.',
      'Requires `ai:run` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Triage one or more failure clusters at once, as the failure inbox does.',
      '`action` applies to every cluster:',
      [
        '`status`: set open, resolved or ignored, with an optional `note`',
        '`assign`: to `assignee` (empty to unassign)',
        '`snooze`: hide them from the inbox (omit `snooze` to unsnooze)',
        '`quarantine`, `release`: quarantine every test in them, or release those tests, with a `reason`',
      ],
      'Clusters you cannot reach or that do not exist are skipped and listed in `skippedIds`. `quarantine` and `release` report how many tests changed and, when the project records coverage, `uniqueCoverage`: the code only those tests run among the other non-quarantined tests. Pick the clusters with `list_open_clusters` (queues `quarantine-ready`, `mine`, `regressions`, …).',
      'Requires `triage:write`, or `quarantine:write` for `quarantine` and `release` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Give a verdict on a scenario gap, as the gap inbox does, and return its new status.',
      'Pass the gap id from `list_scenario_gaps`. A verdict counts for or against the detector that raised the gap. `verb` is:',
      [
        '`accept`: queue its draft, optionally for `assignedTo`',
        '`snooze`: for `1-day`, `1-week` or `until-node-changes`',
        '`dismiss`: with a `reason`, `not-worth-testing`, `covered-elsewhere` (with the covering test) or `wrong`',
        '`covered-by`: record the test that covers it, without dismissing it',
      ],
      'Requires `triage:write` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Approve or reject a suggestion to merge two failure clusters that look like one root cause.',
      'Approving merges them: the lower id survives, keeps its triage state and takes the other’s executions, diagnoses and occurrences, and the other is deleted. Rejecting leaves both as they are.',
      'Pass the `clusterId` of a cluster in the `merge-suggestions` queue of `list_open_clusters`, or a `suggestionId` from `get_cluster`’s `mergeSuggestions`; pass `suggestionId` when a cluster has more than one pending suggestion.',
      'Requires `triage:write` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Move some tests out of a failure cluster into a new one, for a cluster that groups failures with different root causes.',
      'It is the cluster page’s **Move to a new cluster**. Pass `testCaseIds` from `get_cluster`’s `affectedTestCases`. Their executions in the cluster move to the new cluster, which gets your optional `triageNote`; their later failures with the same error join it, and the two clusters are never merged automatically. The source cluster’s triage note gains a line naming the move.',
      'Returns the new `clusterId`, absent when none of the tests failed in the cluster.',
      'Requires `triage:write` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Dismiss Piwi’s proposal to quarantine a test, or to release it from quarantine, as the dashboard’s **Dismiss** does.',
      '`proposal` is:',
      [
        '`quarantine`: for a quarantine candidate, one of the costliest flaky tests by the CI minutes their flakiness wastes, which the flaky list marks proposed',
        '`release`: for a quarantined test whose passing streak or verified fix earned its way out (`list_open_clusters` with queue `quarantine-ready` finds their clusters)',
      ],
      'It records the proposal as rejected, with your optional `reason`; nothing else changes, so the test stays out of quarantine, or in it. Dismissing the same proposal again records nothing more, and a dismissed quarantine proposal counts again once a newer run arrives. Fails when the test has no such proposal.',
      'Requires `quarantine:write` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Quarantine one test or release it, as the dashboard’s **Quarantine** and **Release** do.',
      'A quarantined test keeps running and reporting: quarantine only removes it from the CI gate’s verdict, so its passing streak can earn its release. Pass `quarantined: true` with an optional `reason`, or `quarantined: false` to release it (the quarantine stays in its history). Quarantining a test already in quarantine changes nothing and keeps its streak; releasing a test not in quarantine fails.',
      'When the project records coverage, `uniqueCoverage` summarizes the code only this test runs among the other non-quarantined tests: what quarantining it leaves uncovered, or what releasing it covers again (`get_coverage_loss` lists it all). To quarantine every test of a cluster, use `triage_cluster`.',
      'Requires `quarantine:write` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Set a bug report’s status by hand: `dismissed` (not a bug, or not worth a test), `open` (reopen it) or `closed`.',
      'The other statuses, `test-committed` and `looks-fixed`, follow the runs of the test that names the report.',
      'Requires `bug-report:write` (Contributor and above on the project).',
    ),
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
    description: md(
      'Re-run exactly a failure cluster’s affected tests in CI, as the cluster page’s **Re-run in CI** does.',
      'It dispatches the project’s configured workflow or pipeline with the project’s source-control token, and returns the provider and the URL to watch the runs (the re-run’s own id is not known). Fails with the reason when CI re-run is off for the project, no target or token is configured, or the cluster has no supported repository.',
      'Requires `run:control` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Record the first bad commit a `git bisect` found for a failure cluster, as the desktop app does when its bisect ends.',
      'The commit then shows in the fix plan (`get_fix_plan`) next to the regression window. Pass the SHA (7 to 40 hex characters) and, when known, its subject, author and ISO date.',
      'Requires `run:control` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Record a diagnosis you wrote as the current diagnosis of a failure cluster or of one failing execution.',
      'Pass `clusterId`, or `executionId` for a failure in no cluster or whose cause is its own (refused for an execution that did not fail). It works without an AI provider on this instance, and the previous diagnosis stays in the history. Pass the `model` you run on and the `diagnosis` in the JSON schema Piwi asks a model for:',
      [
        '`summary`',
        '`confidenceScore`: 0-100',
        '`severity`: blocker, high, medium or low',
        '`affectedArea`, or null',
        '`hypotheses`, ranked, each with `category` (app-bug, test-bug, flaky-test, infrastructure, environment or unknown), `rootCause`, `likelihood` (0-100) and `evidence`',
        '`suggestedFix`: `description`, then `file`, `code` and `patch`, each null when unknown',
        '`investigationSteps` and `preventionTips`',
      ],
      'When source control is connected, your patch (a unified diff) is checked against the source at the commit the failure happened at, and the answer says whether it applies. Returns the `diagnosisId` to pass to `report_fix_attempt`, with the `clusterId` or `executionId` it was recorded on.',
      'Requires `ai:run` (Maintainer and above on the project).',
    ),
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
    description: md(
      'Record that you changed the code to fix a failure cluster, once the change is made, so Piwi can verify it.',
      'Pass:',
      [
        '`kind`: `patch`, `locator-edit` or `fix-plan`',
        '`commit` (7 to 40 hex characters), or the `branch` the change is on',
        'the `patch` you applied (stored as its hash), or its `patchHash`',
        'for a locator edit, `edit`: `filePath`, `line`, `from`, `to`',
        '`diagnosisId`: the diagnosis you followed, from `get_fix_plan` or `record_diagnosis` (the cluster’s, or one of its failures’)',
      ],
      'It is recorded as applied. When the cluster’s tests pass on a later commit, Piwi records it verified (tied by the commit, by a `Piwi-Cluster: <clusterId>` trailer in the commit message, or by the branch) and shows it on the cluster’s timeline; a later failure records it regressed. Add the trailer `get_fix_plan` suggests (`verify.commitTrailer`) to your commit message. Reporting the same change twice records it once.',
      'Requires `run:control` (Maintainer and above on the project).',
    ),
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
    permission: ['run:submit', 'run:control'],
    description: md(
      'Mark a test run as an environment incident, or clear the flag, as the run page does.',
      'An incident run’s failures come from the environment under test being down, not from the tests or the code. A flagged run is left out of baselines, fix verification, flaky scores and auto-heal, and the gate answers inconclusive for it. Pass `incident: true` with an optional `reason`, or `incident: false` to clear it.',
      'Requires `run:submit` or `run:control` (Uploader, Maintainer and above on the project).',
    ),
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
    description: md(
      'Link an existing ticket or pull request to a failure cluster, an execution, a test case, a run or a bug report, as the **Links** panel does.',
      'Any http or https URL works; one from a connected tracker is matched to its connection and shows its live status. Returns the stored link. To file a new Jira issue, use `create_issue`.',
      'Requires `link:write` (Contributor and above on the project).',
    ),
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
    description: md(
      'Remove a ticket or pull request link from a failure cluster, an execution, a test case, a run or a bug report, as the **Links** panel does.',
      'Pass the entity and the URL `link_issue` took (`list_links` shows them). Every link of that entity to that URL is removed; the ticket itself is untouched. Fails when the entity has no link to the URL. Returns how many links were removed.',
      'Requires `link:write` (Contributor and above on the project).',
    ),
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
    description: md(
      'Register a page-object method or helper in a project’s test-function catalog, so Piwi Picker and its recorder write a call to your code instead of raw locator lines.',
      'This tool calls no AI: read the function’s source yourself and fill in the fields; the tool validates their shape and stores them. Two fields cannot be read from the code: `module` (the import specifier of the file it lives in) and the optional `urlPattern` (the pages it applies to). The other fields follow these extraction rules:',
      EXTRACT_RULES,
      'The `notes` the rules describe have no field here: say what the steps could not represent in your answer instead.',
      'Requires `test-assets:write` (Maintainer and above on the project).',
    ),
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
        confidence: {
          type: 'number',
          description: 'Your 0-1 confidence that the steps represent what the code does',
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
    description: md(
      'Answer a question about Piwi itself from its own documentation, which ships with this server and matches the running version.',
      'Call it before answering a question about Piwi rather than about test results: what it is and is not, its pieces, how to set it up and configure it, what this instance has switched on, and where to report a bug. With no arguments it returns an overview and these topics:',
      [
        '`ecosystem`: every piece (server, desktop app, reporter and `piwi` CLI, capture fixtures, AI steps, backend instrumentation, browser and editor extensions, MCP server, agent skills, REST API, metrics export), what it is, how to get it, when you need it',
        '`choices`: the setup decisions and their options',
        '`features`: what each feature needs and where it lives',
        '`configuration`: every `PIWI_*` variable',
        '`mcp`: this server’s modules, tools, prompts and skills',
        '`feedback`: where bugs, ideas and questions go',
        '`docs`: the page index',
      ],
      '`page` reads a page or one section (`guide/ci`, `guide/ci#sharding`); `query` searches every page and variable. What changed between versions is `get_release_notes`.',
    ),
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
    description: md(
      'Find a pull request’s uncovered changes: the files it touched, joined to the tests that observably reach them, grouped by ticket.',
      'Pass a `run` to diff it against its baseline, or explicit `base` and `head` commits. Returns an empty result when no source-control token or diff is available. Each file has one `reach`:',
      [
        '`reached`: a test of this run reached it, or a suite of the head commit’s coverage ran one of its changed lines (named in `suites`)',
        '`reached-earlier`: only a test of the project’s last `windowRuns` runs did, so the run was narrowed and no test is missing',
        '`unreached`: an uncovered change, the file that needs a scenario',
        'not counted, and totaled in `notCounted`: `not-observable` (nothing maps the file to a test), `out-of-scope` (the project’s coverage scope leaves it out) and `deleted`',
      ],
      'When the head commit has combined coverage (uploaded suites and its complete runs), each file it counts carries `lines`: its changed lines, those that ran, those undetermined, and the `notRun` ranges no suite ran, reached files included. `patchCoverage` sums them, in total, by unit suite and for the end-to-end suite.',
    ),
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
    description: md(
      'Read coverage: which code ran, and which tests run it.',
      'Use it after running a new test with server coverage, to check it reaches its target. Lines are 1-based, with ranges written like `12-15,20`. It reads one of two views:',
      [
        '**a file**, with `projectId` and `file`: its versions on a branch, each with its executable lines and its executed ranges grouped by the tests that ran them (positions in `tests`); add `lines` for the test running most of the function around them, the one to copy',
        '**an execution**, with `executionId`, `testCaseId` (its latest execution with coverage) or `projectId`, `testFile` and `testTitle`: its files; with `file`, that file’s ranges; with `file` and `lines`, which target lines ran, did not run or cannot be told, the target lines that cannot run, and the nearest test when one did not run',
      ],
      'An incomplete capture never says a line did not run.',
    ),
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
    description: md(
      'Compare the code a test ran across its executions.',
      'Pass one of:',
      [
        '`executionId`, a failure: the files, lines and functions it ran that the test’s last passing execution with coverage did not, and the reverse, with the baseline used (execution, run, branch, commit); a file at another version is marked changed, not compared',
        '`testCaseId`: how its coverage varies across its last 30 executions, the code that ran in only some of them, and the earlier test whose having run before it (in the same run, or on the same worker) predicts that code, with the agreement and counts; `orderDependent` is set when its failures follow that code, a sign it depends on state another test leaves',
      ],
      'An incomplete capture never yields a “did not run” claim.',
    ),
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
    description: md(
      'Find what quarantining, skipping or deleting tests would leave uncovered.',
      'Use it before quarantining or deleting a test. From the latest coverage on the default branch, it returns per file the lines and functions no other trusted (non-quarantined) test runs, those only flaky tests run besides them, and the files no other test reaches. A file other tests ran only at another version is `uncertain`, never claimed.',
    ),
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
    description: md(
      'Get a commit’s combined coverage: every suite that ran the code, counted on one set of executable lines per file version.',
      'The suites are the unit-test reports uploaded with `piwi coverage upload`, and `e2e`, the coverage of the commit’s complete Playwright runs. Without `commit`, it reads the newest commit with coverage on `branch` (the default branch when absent). It returns:',
      [
        'the totals and each suite’s lines (`executedLines` of `executableLines`, with `linePercent`) and functions',
        '`undeterminedLines`: unrun lines inside functions the browser suite ran, never counted as run',
        'the lines only unit tests run, and those only end-to-end tests run',
        'the files without coverage data',
        '`areas`: each named area of the code (such as front and back), with each suite’s share',
        'one `folder`’s breakdown (kept to one `area` when given), with its least-covered files first in `leastCovered`: where a test is most missing',
        'with `file`, which suites ran each of its lines',
      ],
      '`notes` says what the numbers leave out or take from elsewhere: a suite `carried` from an earlier commit, an `incomplete` report, a `missing-suite`, `no-inventory`, totals under an earlier scope (`scope-changed`), `runs-not-counted`, and `runs-incomplete` (counted runs whose backend restarted or was unreachable, so their server coverage misses what the backend ran outside a request). On a branch, a commit a newer one superseded keeps only its totals (`detailRemoved`, `supersededBy`), with no folder breakdown or file lines.',
    ),
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
        area: {
          type: 'string',
          description: 'One of the project’s named areas (`front`, `back`): the breakdown keeps to its files',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_scenario_gaps',
    module: 'workflow',
    capability: 'test-map',
    description: md(
      'List a project’s scenario gaps, ranked: the tests that do not exist yet, each with its class, evidence lines and exposure score.',
      'Every evidence line is observed reach, never instrumented coverage. `draft_scenario` turns a gap into a test skeleton.',
    ),
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
    description: md(
      'Draft a deterministic test skeleton for a scenario gap, as text to paste or hand to an agent; nothing is committed.',
      'Pass the gap id from `list_scenario_gaps`. The skeleton has a title from the gap, `piwi:` annotations from the nearest test, the graph path from a reached page to the gap as its steps, the catalog’s page-object methods where they match, and a TODO assertion naming what to check.',
    ),
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
    description: md(
      'Walk the feature graph around a node: the tests, pages, controls, routes, handlers and dependencies within `depth` hops, and the edges between them.',
      'Use it to see the blast radius of a change, or what a test protects. `node` is `kind:key`, such as `route:POST /api/orders` or `page:/checkout`, and `depth` is capped at six. Each node comes with its gap class and the tests that reach it.',
    ),
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
    description: md(
      'Get a quality report as its bundle: a built-in dashboard rendered over a scope, every string already formatted.',
      'Use it to answer how a suite did this week, or to post a summary. No number comes from a model: the verdict is built by rules. `dashboard` is:',
      [
        '`executive`: a rule-based verdict, headline numbers, the pass-rate trend, what changed, what is being done and the risks',
        '`engineering`: the executive report plus flaky tests, clusters, CI time, detail and scenario gaps',
        '`team`: the engineering report for one owner, given in `owners`',
        '`gaps-digest`: the Test Map’s weekly digest',
        '`overview`: the analytics page',
      ],
    ),
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
    description: md(
      'Get what changed in each Piwi release, from the changelog shipped with this server.',
      'It ends at the running version; newer releases are on GitHub. With no arguments it returns the running version’s notes and the ten most recent releases; otherwise:',
      [
        '`version` (`0.36.0`, or `0.36` for every release of a minor): those releases in full, with highlights, breaking changes, features and fixes',
        '`since`: a summary of every release after a version, breaking changes first, for an upgrade',
        '`query`: the entries that mention every term (which release added share links?), within `version` or `since` when given',
      ],
    ),
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
    description: md(
      'Get one metric over a scope: its value, its change against the comparison period, its definition and its series.',
      'The series is bucketed over the period (`by`), with the comparison period aligned bucket for bucket. A rate is null, with its `sample`, until enough items count; a metric whose capability is declined is refused.',
      'Metrics: test-pass-rate, run-success-rate, runs, suite-size, flaky-occurrences, flaky-tests, wasted-ci-minutes, wasted-ci-cost, ci-time, new-regressions, newly-flaky, average-run-duration, average-p90-test-duration, open-failure-causes, failure-causes-opened, failure-causes-fixed, median-time-to-fix, oldest-open-failure-cause, fixes-that-held, quarantine-debt, and the hand-back metrics heal-adoption, heal-pr-merge-rate, diagnosis-helpful-rate, diagnosis-verified-rate, gate-blocked-merges, gate-overrides, flakes-verified-fixed.',
    ),
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
    description: md(
      'List every dashboard you can open, built-in and saved, with its id, name, description, owner, visibility and widget count.',
      'The built-in ones are `overview` (the analytics page) and the report dashboards `executive`, `engineering` and `gaps-digest`; the saved ones are those shared with everyone, and yours. Pass an id to `get_dashboard`.',
    ),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_dashboard',
    module: 'core',
    description: md(
      'Get one dashboard with every widget’s data, band by band: the JSON its page renders.',
      'Use it to answer how a dashboard did over a period. Its scope is the dashboard’s own: a scope key you pass (`period`, `projectIds`, …) replaces that key only, so a period alone keeps its projects and filters, and each widget’s own period or narrower filters still apply.',
      'A dashboard grants no access: widgets are computed over your projects only, and `hiddenProjects` counts those of its scope you cannot open.',
    ),
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
    description: md(
      'Compare a scope’s headline metrics over two periods you choose, such as this sprint against the last one.',
      'Each metric is given over `a`, with its value over `b` as the previous value, and the change. `a` and `b` take the period syntax of the other tools (`last-7d`, `last-month`, `2026-08-01..2026-08-31`, `release-1`, …).',
    ),
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
    description: md(
      'List a project’s bug reports from Piwi Picker, newest first.',
      'Each has its status (`open`, `test-committed`, `looks-fixed`, `closed`, `dismissed`), page, reporter, the test that reproduces it once committed (`testCaseId`) and how many reproductions were recorded. `get_bug_report` returns one report’s steps and evidence.',
    ),
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
    description: md(
      'Get one bug report with its steps, what each expected assertion found instead, its evidence and the test that reproduces it.',
      'It holds the steps in words and the steps document itself (to replay or render), the evidence (console errors, failed requests with their status, the page outline) and the reproductions recorded since. `render_steps` with its id writes the failing test to commit.',
    ),
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
    description: md(
      'Render a steps document as a Playwright spec, with the converter every Piwi surface uses.',
      'Returns `{ code, warnings }`, with the spec’s `path` for a bug report. Pass one of:',
      [
        '`bugReportId`: the report’s spec, with the project’s generated-spec settings, function catalog and suite locators; `mode` `commit` (the default) adds `test.fail()`, `@bug` and `piwi:bug`, to commit now, and `run` leaves `test.fail()` out, to reproduce',
        '`steps`: a steps document, as Piwi Picker’s **Download steps** writes it, with converter `options`',
      ],
    ),
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
    description: md(
      'Import a Playwright blob report or trace `.zip` from a path on this machine into a Piwi project.',
      'Desktop app only: the local server reads the file itself and nothing is uploaded, which a hosted Piwi cannot do. Use it after a local or CI run to pull its results in. The project is created if it does not exist, and importing the same archive again changes nothing (it is matched by content hash). Returns the created or updated run.',
      'Requires `storage:manage` (administrators only).',
    ),
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
    description: md(
      'Read a source file on this machine as it is now, not the snippet Piwi captured at failure time, so you fix against the real file.',
      'Desktop app only. Pass `line` for a window around it (40 lines on each side by default, set by `contextLines`), or omit it to read the whole file (up to about 256 KB). Returns the path, the 1-based line range and the text.',
    ),
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
    description: md(
      'Apply Piwi’s recommended locator fix for a failing execution to the test file on this machine.',
      'Desktop app only. It resolves the healing recommendation for `executionId`, finds the failing line under `repoRoot` and rewrites just that one locator call. It previews by default: without `apply: true` it returns the file, the line, the old and new line and a unified diff, changing nothing.',
      'It refuses when the line on disk no longer matches what Piwi recorded (the file drifted), and hands back the diff to place by hand.',
    ),
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
  /** The ID the test has in the team's test management tool, when it declares one. */
  externalId?: string;
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
