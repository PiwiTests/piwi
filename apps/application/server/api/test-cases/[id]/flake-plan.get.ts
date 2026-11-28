import {
  FLAKE_EXPERIMENT_SOURCES,
  FlakePlanUnavailable,
  getFlakeExperimentPlan,
  type FlakeExperimentSource,
} from '#shared/handlers/flake-lab';
import { isReadOnly } from '../../../utils/operator-limits';
import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Flake-lab plan for a test case',
    description:
      'The experiment `piwi flake` runs on one test: the control arm (no condition), then one arm per suspect of the test’s flake profile, most likely first, each condition in the flake plan-file shape (an `alongside` or `after` test named by `{ file, title, suite }`), and `combined`, every arm’s conditions at once. It carries the `flakeErrorSignature` of each of the test’s failures in the profile window, the commit of its latest failure, the Playwright project its failures ran in and the median duration of its passes. With `kind=verify` it reruns the arm of the test’s latest reproduced experiment and its control, for enough runs that a failure at the reproduced rate would have shown with 95% confidence (⌈ln 0.05 / ln(1 − rate)⌉, at least 5; 409 when nothing reproduced it yet). Records an unfinished experiment and returns its id unless `record=false` or the instance is read-only, when `experimentId` is null.',
    'x-required-permission': ['run:submit', 'run:control'],
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['reproduce', 'verify'] } },
      {
        name: 'runs',
        in: 'query',
        required: false,
        description:
          'Runs of each arm (1–100); defaults to 10, or for verify to ⌈ln 0.05 / ln(1 − rate)⌉ (at least 5) for the rate the test reproduced at',
        schema: { type: 'integer' },
      },
      {
        name: 'commit',
        in: 'query',
        required: false,
        description: 'The commit the lab runs',
        schema: { type: 'string' },
      },
      { name: 'source', in: 'query', required: false, schema: { type: 'string', enum: ['cli', 'desktop', 'ci'] } },
      { name: 'machine', in: 'query', required: false, schema: { type: 'string' } },
      {
        name: 'record',
        in: 'query',
        required: false,
        description: '`false` returns the plan without recording an experiment',
        schema: { type: 'boolean' },
      },
    ],
  },
});

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

export default eventHandler(async (event) => {
  const testCaseId = requireRouteId(event, 'id', 'test case ID');
  const { db } = await requireResolvedProjectAccess(event, testCaseId, resolveCaseProjectId, 'Test case');
  const query = getQuery(event);
  const kind = query.kind ?? 'reproduce';
  if (kind !== 'reproduce' && kind !== 'verify') {
    throw apiError({ statusCode: 400, message: 'kind must be reproduce or verify' });
  }
  let runs: number | null = null;
  if (query.runs != null && query.runs !== '') {
    runs = Number(query.runs);
    if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
      throw apiError({ statusCode: 400, message: 'runs must be a whole number from 1 to 100' });
    }
  }
  const source = (query.source ?? 'cli') as FlakeExperimentSource;
  if (!FLAKE_EXPERIMENT_SOURCES.includes(source)) {
    throw apiError({ statusCode: 400, message: 'source must be cli, desktop or ci' });
  }
  try {
    return await getFlakeExperimentPlan(db, testCaseId, {
      kind,
      runs,
      record: !isReadOnly() && query.record !== 'false' && query.record !== '0',
      commit: text(query.commit, 64),
      source,
      machine: text(query.machine, 128),
    });
  } catch (error) {
    if (error instanceof FlakePlanUnavailable) throw apiError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});
