/**
 * Compare with team instance: what a connected desktop app sends the team instance about a test that ran on its
 * machine, and what the instance answers (`GET /api/run-targets/projects/:id/test-comparison`). The desktop app sends
 * the test's identity, the Playwright project, the run's environment, commit and branch, and the failure's fingerprint;
 * the instance answers how the test does in its CI, the cluster holding the same error, and the snapshot of the
 * closest CI pass, which the desktop app compares with its own run. Pages are named by their path on the instance.
 */
import { z } from 'zod';

/** How many results of each kind the answer holds at most. */
export const TEST_COMPARISON_LIMITS = {
  /** The reference runs' (CI) latest results. */
  ci: 40,
  /** The team's other shared runs' (a teammate's machine) latest results. */
  local: 20,
  /** The reference results on the local run's commit, even when older than the latest. */
  commit: 10,
} as const;

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim() || null)
    .optional()
    .transform((value) => value ?? null);

/** The query of the route. `filePath` and `title` name the test; everything else is optional. */
export const testComparisonQuerySchema = z.object({
  externalId: optionalText(200),
  filePath: z.string().trim().min(1).max(1000),
  /** The describe path, its titles joined by `\x1f`, as a test case stores it. */
  suitePath: z.string().max(4000).optional().default(''),
  title: z.string().trim().min(1).max(2000),
  /** The Playwright project the local execution ran in (`browserName`). */
  playwrightProject: optionalText(200),
  /** The local run's environment label: a team environment's key when the run was started for one. */
  environment: optionalText(200),
  branch: optionalText(250),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .transform((value) => value.toLowerCase())
    .optional()
    .transform((value) => value ?? null),
  /** The local failure's fingerprint (`computeErrorFingerprint`), and the `FINGERPRINT_VERSION` it was computed with. */
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .transform((value) => value.toLowerCase())
    .optional()
    .transform((value) => value ?? null),
  fingerprintVersion: z.coerce.number().int().min(1).max(1000).optional().nullable().default(null),
});

export type TestComparisonQuery = z.output<typeof testComparisonQuerySchema>;

/** Where a result's run comes from: the team's CI, or a teammate's machine reporting to the team instance. */
export type TestComparisonSource = 'ci' | 'local';

/** One final attempt of the test on the team instance. */
export interface TestComparisonResult {
  executionId: number;
  runId: number;
  source: TestComparisonSource;
  status: string;
  /** Passed after a failed attempt. */
  flaky: boolean;
  /** When its run started, epoch ms. */
  startTime: number | null;
  /** The team environment's key, else the run's label; null without one. */
  environment: string | null;
  branch: string | null;
  commit: string | null;
  playwrightProject: string | null;
  /** The execution's page on the team instance. */
  path: string;
}

/** The team project's cluster holding the same error, with what the CI saw of it. */
export interface TestComparisonCluster {
  id: number;
  title: string | null;
  status: string;
  /** Failed final attempts of the cluster in reference runs. */
  ciOccurrences: number;
  /** The first and last reference run that failed with it, epoch ms; null with no occurrence. */
  ciFirstSeen: number | null;
  ciLastSeen: number | null;
  /** The tests it failed in the reference runs. */
  ciTests: number;
  path: string;
}

/** The passing CI execution the local one is compared with, as its environment snapshot. */
export interface TestComparisonClosestPass {
  executionId: number;
  runId: number;
  startTime: number | null;
  environment: string | null;
  branch: string | null;
  commit: string | null;
  /** Whether the run's checkout matched its commit (`clean`, `dirty`); null when the reporter did not tell. */
  worktree: 'clean' | 'dirty' | null;
  /** On the local run's commit. */
  sameCommit: boolean;
  /** The registered environment keys (`buildEnvironmentSnapshot`), and the ones whose value was inferred. */
  snapshot: { values: Record<string, string | null>; inferred: string[] };
  path: string;
}

/** The answer of the route. */
export interface TestComparison {
  /** The test on the team instance; null when the team project holds no test of that identity. */
  testCase: {
    id: number;
    title: string;
    filePath: string;
    suitePath: string;
    quarantined: boolean;
    flakyRootCause: string | null;
    path: string;
  } | null;
  /** The team project's default branch. */
  defaultBranch: string | null;
  /**
   * Whether the results are the local Playwright project's. False when the CI ran the test in no such project, or
   * none was sent: the results are then every project's.
   */
  playwrightProjectMatched: boolean;
  /** The reference and shared local results, newest first, each once. */
  history: TestComparisonResult[];
  /** False when the instance computes fingerprints with another `FINGERPRINT_VERSION`: no cluster can be matched. */
  fingerprintComparable: boolean;
  cluster: TestComparisonCluster | null;
  closestPass: TestComparisonClosestPass | null;
}
