import { z } from 'zod';
import { apiError } from './api-error';
import { optionalNumber, optionalString, problem, wireCaseSchema } from './wire-case-problem';

/** The status a batch delivery gives its run: Playwright's `FullResult.status`. */
const RUN_STATUSES = ['passed', 'failed', 'timedout', 'interrupted'] as const;

/** The run fields of a batch delivery (`TestRunSubmitPayload`): the body of `/submit`, the `testRun` field of `/upload`. */
const batchRunSchema = z.object({
  status: z.enum(RUN_STATUSES),
  startTime: z
    .union([z.string(), z.number()])
    .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Invalid date'),
  duration: optionalNumber,
  totalTests: optionalNumber,
  passedTests: optionalNumber,
  failedTests: optionalNumber,
  timedOutTests: optionalNumber,
  skippedTests: optionalNumber,
  didNotRunTests: optionalNumber,
  environment: optionalString,
  label: optionalString,
  metadata: z.record(z.string(), z.unknown()).nullish(),
  instanceId: optionalString,
  playwrightVersion: optionalString,
  reporterVersion: optionalString,
  shardIndex: optionalNumber,
  shardTotal: optionalNumber,
  setupSteps: z.array(z.unknown()).nullish(),
});

const testCasesSchema = z.array(wireCaseSchema);

const submitBodySchema = batchRunSchema.extend({
  projectName: z.string().min(1),
  testCases: testCasesSchema.nullish(),
});

function refuse(found: string | null): void {
  if (found) throw apiError({ statusCode: 400, message: `Invalid ${found}` });
}

/** Refuse, with a 400 naming the field, a `/submit` body that is not a run with its test cases. */
export function checkSubmitBody(body: unknown): void {
  refuse(problem(submitBodySchema, body));
}

/** Refuse, with a 400 naming the field, the `testRun` and `testCases` fields of an `/upload` that creates a run. */
export function checkUploadRun(testRun: unknown, testCases: unknown): void {
  refuse(problem(batchRunSchema, testRun, ['testRun']) ?? problem(testCasesSchema, testCases, ['testCases']));
}
