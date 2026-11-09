/**
 * The agents' write log: which MCP tools write (and are logged), what each
 * call acted on, and how the dashboard says it. Read tools are never logged.
 *
 * Pure, so the route, the cluster's activity and the tests share it.
 */

/** The MCP tools that change something; every call of one is logged. */
export const MCP_WRITE_TOOLS = [
  'set_cluster_status',
  'set_cluster_base_commit',
  'submit_diagnosis_feedback',
  'run_cluster_diagnosis',
  'run_execution_diagnosis',
  'record_diagnosis',
  'report_fix_attempt',
  'triage_cluster',
  'triage_gap',
  'decide_merge_suggestion',
  'move_tests_to_new_cluster',
  'dismiss_quarantine_proposal',
  'set_test_quarantine',
  'set_bug_report_status',
  'set_run_incident',
  'rerun_cluster_in_ci',
  'set_cluster_bisect',
  'link_issue',
  'unlink_issue',
  'create_issue',
  'create_test_function',
  'apply_locator_fix',
  'import_local_report',
] as const;
export type McpWriteTool = (typeof MCP_WRITE_TOOLS)[number];

const WRITE_TOOLS = new Set<string>(MCP_WRITE_TOOLS);

export function isMcpWriteTool(name: string): name is McpWriteTool {
  return WRITE_TOOLS.has(name);
}

/** What a logged call acted on. */
export type McpCallSubjectType =
  | 'cluster'
  | 'execution'
  | 'gap'
  | 'bug-report'
  | 'run'
  | 'test-case'
  | 'suggestion'
  | 'diagnosis';

export interface McpCallSubject {
  type: McpCallSubjectType;
  id: number;
}

/** The most rows one call writes: a call on several clusters logs one row per cluster. */
export const MAX_SUBJECTS_PER_CALL = 200;

function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

const LINK_ENTITY_SUBJECTS: Record<string, McpCallSubjectType> = {
  failure_cluster: 'cluster',
  test_runs_case: 'execution',
  test_case: 'test-case',
  test_run: 'run',
  bug_report: 'bug-report',
};

/**
 * What a write call acted on, read from its arguments: one subject, one per
 * cluster for a call on several clusters, or none when the arguments name
 * nothing the log can point at. A call that creates a cluster also names it,
 * read from its `output`. A call on several clusters names those it applied
 * to: the ones it skipped (out of the caller's reach, or missing), read from
 * its `output`, are left out, and a call that failed applied to none.
 */
export function mcpCallSubjects(tool: string, args: Record<string, unknown>, output?: unknown): McpCallSubject[] {
  if (tool === 'triage_cluster' && Array.isArray(args.clusterIds)) {
    if (output == null) return [];
    const skippedIds = (output as { skippedIds?: unknown }).skippedIds;
    const skipped = new Set(Array.isArray(skippedIds) ? skippedIds.map(positiveInt) : []);
    const ids = [...new Set(args.clusterIds.map(positiveInt).filter((id): id is number => id != null))];
    return ids
      .filter((id) => !skipped.has(id))
      .slice(0, MAX_SUBJECTS_PER_CALL)
      .map((id) => ({ type: 'cluster', id }));
  }
  if (tool === 'link_issue' || tool === 'unlink_issue' || tool === 'create_issue') {
    const type = LINK_ENTITY_SUBJECTS[String(args.entityType ?? '')];
    const id = positiveInt(args.entityId);
    if (type && id) return [{ type, id }];
  }
  const pick = (type: McpCallSubjectType, raw: unknown): McpCallSubject[] => {
    const id = positiveInt(raw);
    return id ? [{ type, id }] : [];
  };
  if (tool === 'move_tests_to_new_cluster') {
    const created = (output as { clusterId?: unknown } | null | undefined)?.clusterId;
    return [...pick('cluster', args.clusterId), ...pick('cluster', created)];
  }
  if (args.clusterId != null) return pick('cluster', args.clusterId);
  if (args.executionId != null) return pick('execution', args.executionId);
  if (tool === 'triage_gap') return pick('gap', args.gapId);
  if (tool === 'set_bug_report_status') return pick('bug-report', args.id);
  if (tool === 'set_run_incident') return pick('run', args.runId);
  if (tool === 'submit_diagnosis_feedback') return pick('diagnosis', args.diagnosisId);
  if (tool === 'decide_merge_suggestion') return pick('suggestion', args.suggestionId);
  if (tool === 'dismiss_quarantine_proposal' || tool === 'set_test_quarantine')
    return pick('test-case', args.testCaseId);
  return [];
}

/** The project a call names directly, when its arguments carry one. */
export function mcpCallProjectId(args: Record<string, unknown>): number | null {
  return positiveInt(args.projectId);
}

const ACTIONS: Record<McpWriteTool, string> = {
  set_cluster_status: 'changed the status',
  set_cluster_base_commit: 'set the base commit',
  submit_diagnosis_feedback: 'rated the diagnosis',
  run_cluster_diagnosis: 'ran a diagnosis',
  run_execution_diagnosis: 'ran a diagnosis of a failure',
  record_diagnosis: 'recorded a diagnosis',
  report_fix_attempt: 'recorded a fix attempt',
  triage_cluster: 'triaged the cluster',
  triage_gap: 'triaged a gap',
  decide_merge_suggestion: 'decided a merge suggestion',
  move_tests_to_new_cluster: 'moved tests to a new cluster',
  dismiss_quarantine_proposal: 'dismissed a quarantine proposal',
  set_test_quarantine: 'quarantined or released a test',
  set_bug_report_status: 'changed a bug report',
  set_run_incident: 'changed the incident flag',
  rerun_cluster_in_ci: 're-ran the tests in CI',
  set_cluster_bisect: 'recorded the first bad commit',
  link_issue: 'linked an issue',
  unlink_issue: 'removed a link',
  create_issue: 'filed an issue',
  create_test_function: 'added a test function',
  apply_locator_fix: 'applied a locator fix',
  import_local_report: 'imported a local report',
};

/** "An agent recorded a fix attempt": how the dashboard says one logged call. */
export function describeMcpCall(tool: string, result: string): string {
  const action = isMcpWriteTool(tool) ? ACTIONS[tool] : `called ${tool}`;
  return result === 'error' ? `An agent tried and failed: ${action}` : `An agent ${action}`;
}
