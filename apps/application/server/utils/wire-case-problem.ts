/**
 * What is wrong with what a reporter sent, field by field: `batch-payload.ts` answers a batch 400 with it, and
 * `/events` and the demo's ingest leave out a streamed result it finds wrong. It imports nothing but zod, so the demo's
 * service worker can import it.
 */
import { z } from 'zod';

export const optionalNumber = z.number().nullish();
export const optionalString = z.string().nullish();

/**
 * A test case as the reporter sends it (`TestCasePayload`), in a batch or as a streamed `complete` event. The fields
 * stored in a column of their own, or read as a given type, are checked; the others are sanitized where they are
 * stored, and a field the schema does not name passes.
 */
export const wireCaseSchema = z.object({
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

/** A field's name as a client wrote it: `testCases[2].startedAt`. */
function fieldName(path: PropertyKey[]): string {
  return path.reduce<string>(
    (name, key) => (typeof key === 'number' ? `${name}[${key}]` : name ? `${name}.${String(key)}` : String(key)),
    '',
  );
}

/** What is wrong with `value`, as `<field> (<problem>)` for its first problem; null when nothing is. */
export function problem(schema: z.ZodType, value: unknown, path: PropertyKey[] = []): string | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0]!;
  return `${fieldName([...path, ...issue.path]) || 'body'} (${issue.message})`;
}

/** What is wrong with a test case the reporter sent, or null when it can be stored. */
export function wireCaseProblem(testCase: unknown): string | null {
  return problem(wireCaseSchema, testCase);
}
