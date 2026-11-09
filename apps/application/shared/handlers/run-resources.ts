import { and, eq, isNotNull } from 'drizzle-orm';
import { testRuns, testRunsCases, testCases } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { findingHistoryByFingerprint, runFindingsNovelty } from './resource-findings';
import { isPassiveCapabilityDeclined } from './capabilities';
import {
  browserCpuMs,
  peakRssMb,
  sanitizeExecutionResources,
  type StoredResourceReport,
} from '#shared/resource-report';
import type { WireResourceTimeline } from '#shared/types';
import { readResourceReport } from './resource-reports';

/**
 * A run's resources, as its Resources tab reads them: the report each of its
 * reporters sent (findings and what the run cost each machine), and the
 * executions that cost the most, from what each one measured. And the
 * resources over time, as the run's workers timeline draws them.
 */

/** One execution's cost, as the tab lists it. */
export interface RunResourceExecution {
  executionId: number;
  testCaseId: number;
  title: string;
  filePath: string;
  line: number | null;
  status: string;
  retries: number;
  /** The worker process and the browser processes it started, together. */
  cpuMs: number;
  /** The browser processes alone (Linux). */
  browserCpuMs: number | null;
  /** The largest browser process during the test. */
  peakRssMb: number | null;
  /** Pages already open in the worker when the test started. */
  openAtStartPages: number;
  /** Objects the test opened itself and left open. */
  leftOpen: number;
}

/** Where a finding of the run stands in its project's history. */
export interface RunFindingHistory {
  /** No earlier run of the base branch showed it. */
  isNew: boolean;
  /** The run it was first seen in, once recorded. */
  firstSeenRunId: number | null;
  /** Runs it showed in, this one included once recorded. */
  runs: number;
  /** It was fixed and came back in this run. */
  reopened: boolean;
}

export interface RunResources {
  report: StoredResourceReport | null;
  /** The branch a finding is new against: the pull request's target, else the default branch. */
  baseBranch: string | null;
  /** Each finding's history, by its identity (`#shared/resource-fingerprint.mjs`). */
  history: Record<string, RunFindingHistory>;
  /** The executions that carried their cost, costliest first. */
  costliest: RunResourceExecution[];
  /** How many executions carried their cost. */
  measuredExecutions: number;
}

/** How many executions the tab lists. */
const COSTLIEST_CAP = 20;

/** A run's resources; null when the run does not exist. */
export async function getRunResources(db: DrizzleDB, runId: number): Promise<RunResources | null> {
  const [run] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return null;
  if (await isPassiveCapabilityDeclined(db, run.projectId, 'resources')) {
    return { report: null, baseBranch: null, history: {}, costliest: [], measuredExecutions: 0 };
  }

  const stored = await readResourceReport(db, runId);
  const rows = await db
    .select({
      executionId: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
      resources: testRunsCases.resources,
      title: testCases.title,
      filePath: testCases.filePath,
      line: testRunsCases.line,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .where(and(eq(testRunsCases.testRunId, runId), isNotNull(testRunsCases.resources)));

  const executions: RunResourceExecution[] = [];
  for (const row of rows) {
    const resources = sanitizeExecutionResources(row.resources);
    if (!resources) continue;
    const browser = browserCpuMs(resources);
    executions.push({
      executionId: row.executionId,
      testCaseId: row.testCaseId,
      title: row.title,
      filePath: row.filePath,
      line: row.line ?? null,
      status: row.status,
      retries: row.retries ?? 0,
      cpuMs: resources.workerCpuMs + (browser ?? 0),
      browserCpuMs: browser,
      peakRssMb: peakRssMb(resources),
      openAtStartPages: resources.openAtStart?.pages ?? 0,
      leftOpen: resources.leftOpen ?? 0,
    });
  }
  executions.sort((a, b) => b.cpuMs - a.cpuMs);

  const novelty = stored.parts.length > 0 ? await runFindingsNovelty(db, runId) : null;
  const recorded = await findingHistoryByFingerprint(
    db,
    run.projectId,
    (novelty?.findings ?? []).map((f) => f.historyFingerprint),
  );
  const history: Record<string, RunFindingHistory> = {};
  for (const { fingerprint, historyFingerprint, isNew } of novelty?.findings ?? []) {
    const row = recorded.get(historyFingerprint);
    history[fingerprint] = {
      isNew,
      firstSeenRunId: row?.firstSeenRunId ?? null,
      runs: row?.runs ?? 0,
      reopened: row?.reopenedRunId === runId,
    };
  }

  return {
    report: stored.parts.length > 0 ? stored : null,
    baseBranch: novelty?.baseBranch ?? null,
    history,
    costliest: executions.slice(0, COSTLIEST_CAP),
    measuredExecutions: executions.length,
  };
}

/** One reporter's resources over time, with what its tracks are drawn against. */
export interface RunResourceTimelinePart {
  shardIndex: number | null;
  timeline: WireResourceTimeline;
  /** The machine's memory, or its container's limit when lower; null without the run sampler. */
  memoryCapacityBytes: number | null;
  /** How the run's memory was measured: PSS, or RSS where PSS could not be read. */
  memoryKind: 'pss' | 'rss' | null;
}

/** What one execution cost, as its worker measured it from the test's start to its end. */
export interface RunExecutionCost {
  executionId: number;
  /** CPU of the worker process and of the browser processes it started. */
  cpuMs: number;
  /** Time the browser processes waited for a CPU (Linux); null where the platform cannot tell. */
  runWaitMs: number | null;
  /** The largest browser process at its peak, in MB. */
  peakRssMb: number | null;
}

/** A run's resources over time, as its workers timeline draws them. */
export interface RunResourceTimeline {
  /** One part per reporter that sent a timeline. */
  parts: RunResourceTimelinePart[];
  /** Each execution that carried its cost. */
  executions: RunExecutionCost[];
}

/** A run's resources over time and each execution's cost; null when the run does not exist. */
export async function getRunResourceTimeline(db: DrizzleDB, runId: number): Promise<RunResourceTimeline | null> {
  const [run] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return null;
  if (await isPassiveCapabilityDeclined(db, run.projectId, 'resources')) return { parts: [], executions: [] };
  const stored = await readResourceReport(db, runId);
  const parts: RunResourceTimelinePart[] = [];
  for (const part of stored.parts) {
    if (!part.timeline) continue;
    const machine = part.profile?.machine ?? null;
    parts.push({
      shardIndex: part.shardIndex ?? null,
      timeline: part.timeline,
      memoryCapacityBytes: machine ? (machine.memoryLimitBytes ?? machine.memoryBytes) || null : null,
      memoryKind: part.profile?.memory.kind ?? null,
    });
  }

  const rows = await db
    .select({ executionId: testRunsCases.id, resources: testRunsCases.resources })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testRunId, runId), isNotNull(testRunsCases.resources)));
  const executions: RunExecutionCost[] = [];
  for (const row of rows) {
    const resources = sanitizeExecutionResources(row.resources);
    if (!resources) continue;
    const waits = Object.values(resources.roles ?? {})
      .map((cost) => cost?.runWaitMs)
      .filter((ms): ms is number => typeof ms === 'number');
    executions.push({
      executionId: row.executionId,
      cpuMs: resources.workerCpuMs + (browserCpuMs(resources) ?? 0),
      runWaitMs: waits.length > 0 ? waits.reduce((sum, ms) => sum + ms, 0) : null,
      peakRssMb: peakRssMb(resources),
    });
  }
  return { parts, executions };
}
