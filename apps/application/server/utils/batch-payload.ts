import { z } from 'zod';
import { apiError } from './api-error';

/** The status a batch delivery gives its run: Playwright's `FullResult.status`. */
const RUN_STATUSES = ['passed', 'failed', 'timedout', 'interrupted'] as const;

const optionalNumber = z.number().nullish();
const optionalString = z.string().nullish();

/**
 * A test case as the reporter sends it (`TestCasePayload`), in a batch or as a streamed `complete` event. The fields
 * stored in a column of their own, or read as a given type, are checked; the others are sanitized where they are
 * stored, and a field the schema does not name passes.
 */
const wireCaseSchema = z.object({
  // Playwright accepts an empty title.
  title: z.string(),
  location: optionalString,
  status: z.string().min(1),
  duration: optionalNumber,
  timeout: optionalNumber,
  error: optionalString,
  retries: optionalNumber,
  repeatEachIndex: optionalNumber,
  workerIndex: optionalNumber,
  shardIndex: optionalNumber,
  startedAt: optionalNumber,
  slowestStepDuration: optionalNumber,
  wastedTimeMs: optionalNumber,
  suitePath: z.array(z.string()).nullish(),
  externalId: optionalString,
  displayTitle: optionalString,
  testSource: optionalString,
  didNotRunReason: optionalString,
  expectedStatus: optionalString,
  blockedBy: optionalString,
});

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

/** A field's name as a client wrote it: `testCases[2].startedAt`. */
function fieldName(path: PropertyKey[]): string {
  return path.reduce<string>(
    (name, key) => (typeof key === 'number' ? `${name}[${key}]` : name ? `${name}.${String(key)}` : String(key)),
    '',
  );
}

/** What is wrong with `value`, as `<field> (<problem>)` for its first problem; null when nothing is. */
function problem(schema: z.ZodType, value: unknown, path: PropertyKey[] = []): string | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0]!;
  return `${fieldName([...path, ...issue.path]) || 'body'} (${issue.message})`;
}

function refuse(found: string | null): void {
  if (found) throw apiError({ statusCode: 400, message: `Invalid ${found}` });
}

/** What is wrong with a test case the reporter sent, or null when it can be stored. */
export function wireCaseProblem(testCase: unknown): string | null {
  return problem(wireCaseSchema, testCase);
}

/** Refuse, with a 400 naming the field, a `/submit` body that is not a run with its test cases. */
export function checkSubmitBody(body: unknown): void {
  refuse(problem(submitBodySchema, body));
}

/** Refuse, with a 400 naming the field, the `testRun` and `testCases` fields of an `/upload` that creates a run. */
export function checkUploadRun(testRun: unknown, testCases: unknown): void {
  refuse(problem(batchRunSchema, testRun, ['testRun']) ?? problem(testCasesSchema, testCases, ['testCases']));
}
