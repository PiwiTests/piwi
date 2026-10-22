import { getDatabase } from '../../../database';
import { readBranchFailures } from '../../../utils/branch-failures';
import { jsonEtag, notModified } from '../../../utils/json-etag';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get the latest complete run on a branch and its failures',
    description:
      'The newest complete run of the project on `branch` (any branch when omitted) (a finished run of the whole suite, never a Flake Lab or probe run, a filtered run or a selection run; a CI run first, else a local one) with its counts, `origin` and `commit`, and its failed executions (at most 200): `{ executionId, testCaseId, clusterId, title, file, line, status, headline, location, message, frames, traces, screenshot, source, runId, browserName, duration, isNew, clusterTitle, owner, note? }`. `location` is the failing call from the error’s first frame outside `node_modules`; `frames` lists those frames innermost first (at most 10), each `file:line:col`; `message` is the error without its stack, at most 12 lines; `traces` and `screenshot` are stored paths served by `/api/files/<path>`; `browserName` is the Playwright project; `duration` is in milliseconds; `clusterTitle` and `owner` are those of the failure cluster and of the test. `run` is null when the branch has no complete run. With `overlays=1`, the finished runs of that run’s branch started after it, whole or partial, of any origin but Flake Lab, probe, bisect and reproduction runs and environment incidents (at most 20, newest first), are laid over it in `overlays`: `{ id, status, origin, isFullRun, startTime, commit, totalTests, passedTests, failedTests, flakyTests, skippedTests }`. For each test and Playwright project, the newest result of those runs and the complete run wins: a failure a later run passed moves to `resolved` (`{ testCaseId, title, file, line, browserName, runId, executionId, baselineExecutionId }`, at most 200), a failure a later run failed again is listed from that run’s execution, and a test that fails in a later run only is listed with `isNew: true`. `source` says which run a failure is listed from (`baseline` or `overlay`), and `runId` names it; `isNew` is, for the complete run, whether the failure is a new regression there, and for a later run, whether the test did not fail on that project in the complete run. A skipped test resolves nothing, nor does a pass on another Playwright project, which the failure notes (`note`: `passed on chromium in run #124`). Without `overlays`, `overlays` and `resolved` are empty. With `run`, that run of the project is the baseline instead (whatever its branch, origin or completeness; `branch` is not read), and the finished runs of its branch started after it are its overlays; a run of another project is refused with 400, a missing one with 404. With `origin=local`, only a developer’s own runs (origin `local`, `desktop` or `editor`) are read: the baseline is the newest complete one on `branch`, and the overlays are local runs only; without such a run, `run` is null and, with `overlays=1`, the finished local runs of the branch are the overlays alone, each of their failures listed with `isNew: true`. Editors show these in their Problems panel and status bar. Carries an `ETag`, which the server derives from the runs the answer reads and what they stored, without computing the answer: a request whose `If-None-Match` names it is answered 304 without a body.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
      {
        name: 'overlays',
        in: 'query',
        required: false,
        description: 'Lay the finished runs of the branch started after the complete run over it (`1` or `true`).',
        schema: { type: 'boolean', default: false },
      },
      {
        name: 'run',
        in: 'query',
        required: false,
        description: 'The baseline: this test run of the project, with the overlays of its branch started after it.',
        schema: { type: 'integer', minimum: 1 },
      },
      {
        name: 'origin',
        in: 'query',
        required: false,
        description:
          '`local`: read a developer’s own runs only (`local`, `desktop`, `editor`). Cannot be combined with `run`.',
        schema: { type: 'string', enum: ['local'] },
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const read = await readBranchFailures(await getDatabase(), id, getQuery(event), (statusCode, message) =>
    apiError({ statusCode, message }),
  );
  // The server's version and what the answer is computed from, read without computing it.
  const appVersion = (useRuntimeConfig(event).public as { appVersion?: string }).appVersion ?? null;
  if (notModified(event, jsonEtag([appVersion, await read.version()]))) return null;
  return read.answer();
});
