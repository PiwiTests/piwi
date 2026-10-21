import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { failureClusters, projects, testCases, testRuns, testRunsCases } from '../../../database/schema';
import { holdsProjectPermission, requireProjectAccess } from '../../../utils/project-access';
import { computeRunInsights } from '#shared/handlers/run-insights';
import { evaluateGatePolicy, isEmptyPolicy, type GateFacts, type GatePolicy } from '@piwitests/core/gate';
import { parseTagFilter } from '#shared/utils/tag-filter';
import { getQuarantinedCaseIds } from '#shared/handlers/quarantine';
import { getSelection, resolveSelectionDefinition } from '#shared/handlers/selections';
import { readChangeCoverage } from '../../../utils/scm/change-coverage';
import { patchCoverageWarning } from '#shared/patch-coverage';
import { runFindingsNovelty } from '#shared/handlers/resource-findings';
import { isLeak } from '#shared/resource-fingerprint.mjs';
import { readRunIncident } from '#shared/run-incident';
import {
  GATE_CLIENT_HEADER,
  gateSource,
  postGateCommitStatus,
  recordGateEvaluation,
} from '../../../utils/gate-evaluations';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Evaluate a CI gate policy against a finished run',
    description:
      'Applies a pass/fail policy to a run and returns every violation, so a pipeline can block a merge on the analysis rather than on the raw exit code of `playwright test`. Rules: `requireTags` (every test carrying the tag must pass), `maxFailed`, `maxNewRegressions`, `maxNewFlaky`, `failOnNewCluster`, `failOnFlaky` (any flaky test in the run), `requireSelection` (re-resolves a named selection and fails if any test it currently matches did not run, or ran and failed — catching a silently shrunk smoke job), `maxLeaks` (browsers, contexts, pages and API contexts the run left open past the scope that opened them, one per opening line, from the reporter’s resource report) and `maxNewLeaks` (those no earlier run of the base branch showed: the pull request’s target, else the default branch). A leak rule on a run that sent no resource report is a violation. A required tag that matches no test in the run is itself a violation, so a typo cannot silently pass. A run flagged as an environment incident gets the verdict `inconclusive` (with `passed: false` and the incident under `facts.incident`), distinct from `passed` and `failed`, whatever the policy. `maxUncoveredChanges` is warn-only: it warns when more of the run’s changed files than the threshold are uncovered changes (counted files no test reached, in the run or the project’s last 30 runs, and no suite ran a changed line of; files outside the coverage scope, deleted or that nothing maps to a test are not counted), without changing the verdict. `minPatchCoverage` (a percentage), its line form, is warn-only too: it warns when fewer of the change’s added and modified lines ran, in the head commit’s combined coverage (the uploaded suites and the commit’s complete runs), or when that coverage counts none of them. Either warns when the run has no source control diff to count. Evaluation does not modify the run. Any reader of the project may evaluate a policy. An evaluation by a caller who holds `run:submit` or `run:control` on the project (the CI key `piwi gate` sends) is stored with its policy, verdict and pull request, so a later merge despite a failed gate is counted; with the project setting `gateStatus` on and pull-request feedback posting commit statuses, its verdict is also posted as the `<statusContext>/gate` commit status. Any other caller gets the verdict only.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              requireTags: { type: 'array', items: { type: 'string' } },
              maxFailed: { type: 'integer', minimum: 0 },
              maxNewRegressions: { type: 'integer', minimum: 0 },
              maxNewFlaky: { type: 'integer', minimum: 0 },
              failOnNewCluster: { type: 'boolean' },
              maxQuarantined: { type: 'integer', minimum: 0 },
              failOnFlaky: { type: 'boolean' },
              requireSelection: { type: 'string' },
              maxUncoveredChanges: { type: 'integer', minimum: 0 },
              minPatchCoverage: { type: 'number', minimum: 0, maximum: 100 },
              maxLeaks: { type: 'integer', minimum: 0 },
              maxNewLeaks: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
  },
});

const FAIL_STATUSES = ['failed', 'timedOut', 'timedout'];

/** Read a percentage, or undefined when the rule was not requested. */
function optionalPercent(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

/** Read a non-negative integer, or undefined when the rule was not requested. */
function optionalCount(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export default eventHandler(async (event) => {
  const id = parseInt(getRouterParam(event, 'id') || '0');
  if (!id) throw apiError({ statusCode: 400, message: 'Invalid test run ID' });

  const db = await getDatabase();
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, id));
  if (!run) throw apiError({ statusCode: 404, message: 'Test run not found' });

  await requireProjectAccess(event, run.projectId);

  const body = (await readBody(event)) as Record<string, unknown> | null;
  const policy: GatePolicy = {
    requireTags: parseTagFilter(Array.isArray(body?.requireTags) ? body.requireTags.join(',') : undefined),
    maxFailed: optionalCount(body?.maxFailed),
    maxNewRegressions: optionalCount(body?.maxNewRegressions),
    maxNewFlaky: optionalCount(body?.maxNewFlaky),
    maxQuarantined: optionalCount(body?.maxQuarantined),
    failOnNewCluster: body?.failOnNewCluster === true,
    failOnFlaky: body?.failOnFlaky === true,
    requireSelection:
      typeof body?.requireSelection === 'string' && body.requireSelection.trim()
        ? body.requireSelection.trim()
        : undefined,
    maxLeaks: optionalCount(body?.maxLeaks),
    maxNewLeaks: optionalCount(body?.maxNewLeaks),
  };

  // `maxUncoveredChanges` is warn-only in its first release: it is reported but
  // never changes the verdict, so a project can watch the number before a
  // blocking mode ships. Off by default; a value (including 0) turns it on.
  const maxUncoveredChanges = optionalCount(body?.maxUncoveredChanges);
  // `minPatchCoverage` is warn-only as well: the number informs, it is not a target.
  const minPatchCoverage = optionalPercent(body?.minPatchCoverage);

  if (isEmptyPolicy(policy) && maxUncoveredChanges == null && minPatchCoverage == null) {
    throw apiError({
      statusCode: 400,
      message:
        'Gate policy is empty — pass at least one of requireTags, maxFailed, maxNewRegressions, maxNewFlaky, maxQuarantined, failOnNewCluster, failOnFlaky, requireSelection, maxLeaks, maxNewLeaks, maxUncoveredChanges or minPatchCoverage',
    });
  }

  if (run.status === 'running' || run.status === 'initializing') {
    throw apiError({ statusCode: 409, message: `Run #${id} has not finished yet (status: ${run.status})` });
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));

  const caseRows = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      tags: testRunsCases.tags,
      failureClusterId: testRunsCases.failureClusterId,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, id));

  // A test with retries has one row per attempt. It counts as passing when any
  // attempt passed, so a flaky-but-recovered test does not trip a required tag
  // — `maxNewFlaky` is the rule for that, and conflating the two would make
  // `requireTags` impossible to satisfy on any suite with retries enabled.
  const passedCaseIds = new Set<number>();
  for (const row of caseRows) {
    if (row.status === 'passed') passedCaseIds.add(row.testCaseId);
  }

  // A quarantined test still ran and still reported — it is only excluded from
  // the verdict. Counting it would defeat the point; hiding that it failed
  // would make a green gate untrustworthy, so the count is reported instead.
  const quarantined = await getQuarantinedCaseIds(db, run.projectId);
  const failingCaseIds = new Set(
    caseRows
      .filter((row) => FAIL_STATUSES.includes(row.status) && !passedCaseIds.has(row.testCaseId))
      .map((row) => row.testCaseId),
  );
  const quarantinedFailures = [...failingCaseIds].filter((id) => quarantined.has(id)).length;
  const countedFailures = Math.max(0, failingCaseIds.size - quarantinedFailures);

  const failingByTag: GateFacts['failingByTag'] = {};
  const unmatchedTags: string[] = [];

  for (const tag of policy.requireTags ?? []) {
    const tagged = caseRows.filter((row) => (Array.isArray(row.tags) ? (row.tags as string[]) : []).includes(tag));
    if (tagged.length === 0) {
      unmatchedTags.push(tag);
      failingByTag[tag] = [];
      continue;
    }

    // One entry per failing test, not per failing attempt.
    const reported = new Set<number>();
    failingByTag[tag] = tagged
      .filter((row) => {
        if (!FAIL_STATUSES.includes(row.status)) return false;
        if (passedCaseIds.has(row.testCaseId)) return false;
        if (quarantined.has(row.testCaseId)) return false;
        if (reported.has(row.testCaseId)) return false;
        reported.add(row.testCaseId);
        return true;
      })
      .map((row) => ({ title: row.title, filePath: row.filePath, executionId: row.id }));
  }

  // require-selection: re-resolve the named selection's current definition and
  // check every test it matches ran and passed in this run. A quarantined test
  // is exempt — quarantine already means "do not gate on this test".
  let selectionFacts: GateFacts['selection'];
  if (policy.requireSelection) {
    const failingExecByCase = new Map<number, number>();
    for (const row of caseRows) {
      if (
        FAIL_STATUSES.includes(row.status) &&
        !passedCaseIds.has(row.testCaseId) &&
        !failingExecByCase.has(row.testCaseId)
      ) {
        failingExecByCase.set(row.testCaseId, row.id);
      }
    }
    const selection = await getSelection(db, run.projectId, policy.requireSelection);
    const matchedTests = selection
      ? (await resolveSelectionDefinition(db, run.projectId, selection.definition, { format: 'json' })).tests
      : [];
    const notRun: NonNullable<GateFacts['selection']>['notRun'] = [];
    const failed: NonNullable<GateFacts['selection']>['failed'] = [];
    for (const test of matchedTests) {
      if (quarantined.has(test.testCaseId)) continue;
      if (passedCaseIds.has(test.testCaseId)) continue; // ran and passed — satisfied
      if (failingExecByCase.has(test.testCaseId)) {
        failed.push({
          title: test.title,
          filePath: test.filePath,
          executionId: failingExecByCase.get(test.testCaseId)!,
        });
      } else {
        // Absent from the run, or present only as a skip — never verified.
        notRun.push({ title: test.title, filePath: test.filePath });
      }
    }
    selectionFacts = {
      key: policy.requireSelection,
      matched: matchedTests.length,
      notRun: notRun.slice(0, 50),
      failed: failed.slice(0, 50),
    };
  }

  const insights = await computeRunInsights(db, id).catch(() => null);
  const caseIdByExecution = new Map(caseRows.map((row) => [row.id, row.testCaseId]));
  const notQuarantined = (entry: { executionId: number }) =>
    !quarantined.has(caseIdByExecution.get(entry.executionId) ?? -1);

  const newClusters = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(and(eq(failureClusters.firstSeenRunId, id), eq(failureClusters.projectId, run.projectId)));

  const siteUrl = (process.env.PIWI_SITE_URL || '').replace(/\/$/, '');

  let resourceFacts: GateFacts['resources'];
  if (policy.maxLeaks != null || policy.maxNewLeaks != null) {
    const novelty = await runFindingsNovelty(db, id);
    const leaks = (novelty?.findings ?? []).filter((f) => isLeak(f.finding));
    const toLeak = (f: (typeof leaks)[number]) => ({
      where: f.finding.where,
      site: f.finding.site ?? null,
      tests: f.finding.tests,
    });
    resourceFacts = {
      reported: novelty !== null,
      leaks: leaks.map(toLeak),
      newLeaks: leaks.filter((f) => f.isNew).map(toLeak),
      baseBranch: novelty?.baseBranch ?? null,
    };
  }

  const facts: GateFacts = {
    runId: id,
    runUrl: siteUrl ? `${siteUrl}/test-runs/${id}` : `/test-runs/${id}`,
    projectName: project?.label || project?.name || 'unknown',
    status: run.status,
    totalTests: run.totalTests,
    failedTests: countedFailures,
    newRegressions: insights?.newRegressions.filter(notQuarantined).length ?? 0,
    newFlaky: insights?.newFlaky.filter(notQuarantined).length ?? 0,
    newClusters: newClusters.length,
    failingByTag,
    unmatchedTags,
    quarantinedFailures,
    quarantinedTotal: quarantined.size,
    flakyTests: run.flakyTests ?? 0,
    selection: selectionFacts,
    resources: resourceFacts,
  };
  const incident = readRunIncident(run.metadata);
  if (incident) facts.incident = { rule: incident.rule, reason: incident.reason, host: incident.host };

  const result = evaluateGatePolicy(facts, policy);

  // Warn-only uncovered changes: the change's files no test reached (the file
  // form) and its patch coverage (the line form), reported without touching the
  // pass/fail verdict.
  const warnings: string[] = [];
  if (maxUncoveredChanges != null || minPatchCoverage != null) {
    const coverage = await readChangeCoverage(db, run.projectId, { runId: id }).catch(() => null);
    if (!coverage?.scmAvailable) {
      warnings.push(
        'Uncovered changes could not be counted: no source control diff for this run (a token, a baseline) — warn-only.',
      );
    } else {
      if (maxUncoveredChanges != null && coverage.uncoveredFiles > maxUncoveredChanges) {
        const n = coverage.uncoveredFiles;
        warnings.push(
          `${n} uncovered ${n === 1 ? 'change' : 'changes'} (threshold ${maxUncoveredChanges}): ` +
            `changed ${n === 1 ? 'file' : 'files'} no test reached — warn-only.`,
        );
      }
      if (minPatchCoverage != null) {
        const warning = patchCoverageWarning(coverage.patchCoverage, minPatchCoverage);
        if (warning) warnings.push(warning);
      }
    }
  }

  // Only a caller who submits or controls the project's runs stores the
  // evaluation and posts its commit status; anyone else gets the verdict only.
  const response = warnings.length > 0 ? { ...result, warnings } : result;
  if (!(await holdsProjectPermission(event, run.projectId, ['run:submit', 'run:control']))) return response;

  // Store the evaluation for the PR state sweep, then post the opt-in commit
  // status. Neither can fail the request: the verdict is the answer.
  const clusterByExecution = new Map(caseRows.map((row) => [row.id, row.failureClusterId]));
  const clusterIds = (insights?.newRegressions ?? [])
    .filter(notQuarantined)
    .map((entry) => clusterByExecution.get(entry.executionId))
    .filter((clusterId): clusterId is number => clusterId != null);
  try {
    await recordGateEvaluation(db, {
      projectId: run.projectId,
      runId: id,
      runMetadata: run.metadata,
      policy: { ...policy, maxUncoveredChanges, minPatchCoverage },
      result,
      source: gateSource(getRequestHeader(event, GATE_CLIENT_HEADER)),
      clusterIds,
    });
  } catch (e) {
    console.error(`[gate] could not store the evaluation of run #${id}`, e);
  }
  void postGateCommitStatus(db, {
    projectId: run.projectId,
    runId: id,
    runMetadata: run.metadata,
    runUrl: facts.runUrl,
    result,
  });

  return response;
});
