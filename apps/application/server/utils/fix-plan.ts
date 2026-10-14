/**
 * A fix plan — everything an agent needs to repair one failure cluster, in a
 * single answer.
 *
 * The parts already existed and were scattered across four tools: the
 * diagnosis, the validated patch, the ranked locator replacement, the failing
 * tests, the source line to edit. An agent asking four questions and stitching
 * the answers together gets a worse result than one that is handed the plan.
 *
 * The last field is the one that matters most. `verify` tells the agent exactly
 * which command proves the work, and that Piwi will record the cluster as fixed
 * when those tests pass — so the loop closes without a human deciding whether
 * it worked.
 *
 * Nothing here leaves the machine it runs on: the dashboard is self-hosted, the
 * model is whatever the operator configured, and the patch was validated
 * against their own source. That is the whole point of doing this locally.
 */
import { and, desc, eq } from 'drizzle-orm';
import { failureClusters, failureDiagnoses, testCases, testRunsCases } from '../database/schema';
import { getLocatorHealingBatch } from './locator-healing';
import { findFixedBefore } from './cluster-memory';
import { getClusterKnownIssue } from './integrations/known-issue';
import { storedPatchValidation, validatePatch } from '#shared/patch';
import { parseCallsiteLocation } from '#shared/callsite-location';
import { buildRetryCommand, buildTitleGrepFlag } from '#shared/retry-command';
import { computeReproduceContext } from '#shared/handlers/reproduce';
import type { FixPlan, FixPlanEdit } from '#shared/fix-plan.types';
import { clusterTrailerLine } from '#shared/commit-trailers';
import type { DrizzleDB } from '#shared/handlers/db';
import type { BrowserConfig } from '#shared/types';

export type { FixPlan, FixPlanEdit } from '#shared/fix-plan.types';

/** Executions inspected for locator suggestions — enough to cover a cluster. */
const MAX_HEALED_CASES = 5;

/**
 * Build the plan for a cluster, or `null` when the cluster does not exist.
 * Every section degrades independently: a cluster with no diagnosis still
 * yields the failing tests and the verification command.
 */
export async function buildFixPlan(db: DrizzleDB, clusterId: number): Promise<FixPlan | null> {
  const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const caseRows = await db
    .select({
      executionId: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      title: testCases.title,
      filePath: testCases.filePath,
      owner: testCases.owner,
      browser: testRunsCases.browser,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .orderBy(desc(testRunsCases.id))
    .limit(100);

  // One entry per test, newest execution first — an agent wants the current
  // shape of each failure, not every historical attempt at it.
  const seen = new Set<number>();
  const failingTests = caseRows
    .filter((row) => (seen.has(row.testCaseId) ? false : (seen.add(row.testCaseId), true)))
    .map((row) => ({
      testCaseId: row.testCaseId,
      title: row.title,
      filePath: row.filePath,
      executionId: row.executionId,
      owner: row.owner,
      projectName: (row.browser as BrowserConfig | null)?.projectName ?? null,
    }));

  // The browser binary the failures ran on — taken from the newest execution, so
  // the reproduction installs the right one.
  const reproBrowser = (caseRows[0]?.browser as BrowserConfig | null)?.browserName ?? null;

  const [diagnosisRow] = await db
    .select()
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.status, 'completed')))
    .orderBy(desc(failureDiagnoses.id))
    .limit(1);

  let diagnosis: FixPlan['diagnosis'] = null;
  if (diagnosisRow) {
    const details = diagnosisRow.details as { suggestedFix?: { patch?: unknown } } | null;
    const patch = typeof details?.suggestedFix?.patch === 'string' ? details.suggestedFix.patch : null;
    diagnosis = {
      id: diagnosisRow.id,
      provider: diagnosisRow.provider,
      model: diagnosisRow.model,
      category: diagnosisRow.category,
      confidence: diagnosisRow.confidence,
      rootCause: diagnosisRow.rootCause,
      summary: diagnosisRow.summary,
      patch,
      // The validation stored at diagnosis time; with none stored, a structural
      // re-parse, so a plan always says whether the patch is usable.
      patchValidation: storedPatchValidation(details) ?? (patch ? validatePatch(patch, new Map()) : null),
    };
  }

  const healingTargets = failingTests.slice(0, MAX_HEALED_CASES).map((test) => test.executionId);
  const healing = await getLocatorHealingBatch(db, healingTargets).catch(() => new Map());

  const edits: FixPlanEdit[] = [];
  for (const test of failingTests.slice(0, MAX_HEALED_CASES)) {
    const result = healing.get(test.executionId);
    const recommended = result?.recommendation?.recommended ?? null;
    if (!result || result.applicable === false || !recommended) continue;

    const loc = parseCallsiteLocation(result.location);
    edits.push({
      filePath: loc?.file || test.filePath,
      line: result.sourceLine?.line ?? loc?.line ?? null,
      currentLine: result.sourceLine?.text ?? null,
      failingLocator: result.failingLocator
        ? `${result.failingLocator.method}(${JSON.stringify(result.failingLocator.args)})`
        : null,
      suggestedLocator: recommended.locator,
      score: recommended.score ?? null,
      // The ready-to-apply edit is computed once by the healing lookup (with the
      // captured source snippet, so its diff carries context).
      edit: result.edit ?? null,
      executionId: test.executionId,
    });
  }

  // Ownership here is only what the test declared. CODEOWNERS resolution needs
  // an SCM client, which pulls in node-only crypto — the server enriches this
  // afterwards via `enrichFixPlanOwnership`, keeping this module bundleable for
  // the in-browser demo.
  const declaredOwner = failingTests.find((test) => test.owner)?.owner ?? null;

  // Files portion — POSIX-normalized, quoted and deduped by the same builder the
  // UI's retry command uses (so a Windows-captured path can't silently fail to
  // match), then scoped to exactly this cluster's tests by title.
  const fileCmd = buildRetryCommand(
    failingTests.map((test) => ({ filePath: test.filePath, title: test.title })),
    { mode: 'file' },
  );
  const grep = buildTitleGrepFlag(failingTests.slice(0, 5).map((test) => test.title));
  const verifyCommand = `${fileCmd || 'npx playwright test'}${grep}`;

  // Reproduce locally and bisect the regression window: the checkout of the
  // failing commit, a pinned install, the browser and the exact test command,
  // then a `git bisect` between the last green commit and this one. Computed from
  // the same last-seen run the "What changed" panel reads, so it degrades in
  // lockstep — no SCM metadata means no bisect, spelled out in the payload.
  const { reproduce, bisect, desktop } = await computeReproduceContext(db, {
    runId: cluster.lastSeenRunId,
    cases: failingTests.map((test) => ({
      filePath: test.filePath,
      title: test.title,
      projectName: test.projectName,
    })),
    browserName: reproBrowser,
    verifyCommand,
    clusterId: cluster.id,
    testCaseIds: failingTests.map((test) => test.testCaseId),
  });

  // Resolved clusters this one resembles, and how each was fixed — best-effort,
  // never a reason the plan fails to build.
  const fixedBefore = await findFixedBefore(db, cluster).catch(() => []);
  const issue = await getClusterKnownIssue(db as never, clusterId).catch(() => null);

  return {
    cluster: {
      id: cluster.id,
      title: cluster.title,
      signature: cluster.signature,
      errorType: cluster.errorType,
      status: cluster.status,
      occurrences: cluster.occurrences,
      fixVerification: cluster.fixVerification,
    },
    diagnosis,
    edits,
    failingTests: failingTests.map(({ owner: _owner, projectName: _projectName, ...rest }) => rest),
    ownership: { owner: declaredOwner, source: declaredOwner ? 'annotation' : null },
    verify: {
      command: verifyCommand,
      expectation:
        'Re-run the affected tests, or the whole suite. When every test in this cluster passes in one run, full or filtered, Piwi records the fix — with the commit and how long the cluster was open — and the cluster stops being reported as open. Put the commit trailer in the commit message of the fix and report the change as a fix attempt, so the fix is tied to it.',
      commitTrailer: clusterTrailerLine(cluster.id),
    },
    reproduce,
    bisect,
    bisectedCommit: desktop.bisectedCommit,
    reproduceDesktop: desktop,
    // Filled in from source control by `withFixPlanSuspectLines`, outside this demo-safe module.
    suspectLines: null,
    fixedBefore,
    issue,
  };
}
