import { and, eq } from 'drizzle-orm';
import { files, testCases, testRunsCases } from '../../../database/schema';
import { getFailureTimeline } from '#shared/handlers/test-cases';
import { getTraceActionCallsitesFromBlob } from '../../../utils/trace-evidence';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Failure timeline for a test case execution',
    description:
      "Places this execution's steps, console entries, network requests and backend log entries on one time axis, marks the moment of failure, and picks a default window around the failed step (the failed step plus 10s before and 2s after, or the whole execution when no step failed). Each step is attributed to the method or `test.step` it was called from — function names come from an uploaded trace, file and line from the reporter. Positions are in ms relative to `origin` (epoch ms), the earliest timestamp in the execution; `testStart` is where the test itself started on that clock, above 0 when evidence was stamped before it. Items that carry no usable timestamp — and evidence with no capture time yet, such as Web Vitals and screenshots — are listed under `unplaced`. `estimated` is true when step positions were derived from durations because the reporter recorded no start times. A step or a request carries `usual`, its median duration in ms over the test's last five passing executions on the same browser (in runs eligible as a baseline, this one left out), when at least two of them ran the same step or called the same route. `resources`, when the run sent a resource report and the project keeps the resources capability, holds what the worker that ran the test used on the same clock: `cpuCores` and `memoryBytes` of the worker with the browsers it started, `openPages` in that worker (each a list of `[ms after origin, value]`, with one reading on each side of the axis), the machine's `cores`, and from the execution's own cost `openAtStart` (pages earlier tests left open in its worker) and `runWaitMs` (time its browsers waited for a CPU).",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');

  // Authorize by the execution's own project: this id may be opened from the
  // cluster page, where it can belong to a run in another project.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  // When a trace exists, parse the per-action call stacks (function names and
  // the caller chain) so the timeline can name the method behind each action.
  // File and line already come from the reporter, so this is enrichment only.
  const [traceRow, [caseRow]] = await Promise.all([
    db
      .select({ path: files.path })
      .from(files)
      .where(and(eq(files.testRunsCaseId, id), eq(files.type, 'trace')))
      .limit(1),
    db
      .select({ filePath: testCases.filePath })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(eq(testRunsCases.id, id))
      .limit(1),
  ]);

  const blobPath = traceRow[0]?.path;
  const traceCallsites = blobPath ? await getTraceActionCallsitesFromBlob(blobPath, caseRow?.filePath ?? null) : null;

  return getFailureTimeline(db, id, { traceCallsites });
});
