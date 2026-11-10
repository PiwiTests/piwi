/**
 * The shapes behind the Perfetto (Trace Event Format) export of a run and of a
 * single execution.
 *
 * `PerfettoRunInput` is the node-free input the pure builder consumes — one run,
 * its executions with their steps and hooks, and the run's suite-level setup
 * steps. `PerfettoTrace` is the Trace Event Format document the builder emits,
 * which opens in ui.perfetto.dev and Chrome's `chrome://tracing`.
 */

/** One flattened step recorded during an execution (the `steps` JSON column). */
export interface PerfettoStep {
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string | null;
  /** Curated per-step arguments (rendered locator, URL, value, `test.step` author values). */
  params?: Record<string, string | number | boolean> | null;
  category?: string | null;
  /** Duration in milliseconds. */
  duration?: number | null;
  /** Absolute start time in milliseconds; enables placing the step in time. */
  startTime?: number | null;
  /** Source pointer `file:line:col`. */
  location?: string | null;
  error?: { message?: string | null } | null;
  failed?: boolean | null;
}

/** A hook/fixture/wait step with absolute timing (the `stepEvents` JSON column). */
export interface PerfettoStepEvent {
  title: string;
  subtitle?: string | null;
  category: string;
  /** Absolute start time in milliseconds. */
  startedAt: number;
  duration: number;
  status?: string | null;
  location?: string | null;
}

/** A suite-level setup step (beforeAll/afterAll) tied to a worker, not a test. */
export interface PerfettoSetupStep extends PerfettoStepEvent {
  workerIndex?: number | null;
}

/** An evidence file attached to an execution. */
export interface PerfettoAttachment {
  name: string;
  /** Storage path, turned into a download URL when a base URL is known. */
  path?: string | null;
  contentType?: string | null;
}

/** One execution (a `test_runs_cases` row) with everything the trace draws. */
export interface PerfettoExecution {
  executionId: number;
  testCaseId?: number | null;
  title: string;
  filePath?: string | null;
  location?: string | null;
  status: string;
  /** Playwright's worker process, new at every start. */
  workerIndex?: number | null;
  /** The worker's lane (Playwright's `parallelIndex`), which names its thread from 1; null from an older reporter. */
  parallelIndex?: number | null;
  shardIndex?: number | null;
  /** Absolute start time in milliseconds. */
  startedAt?: number | null;
  /** Duration in milliseconds. */
  duration?: number | null;
  /** Retry index of this execution (0 for the first attempt). */
  retries?: number | null;
  tags?: string[] | null;
  locks?: string[] | null;
  annotations?: Array<{ type: string; description?: string | null }> | null;
  error?: string | null;
  steps?: PerfettoStep[] | null;
  stepEvents?: PerfettoStepEvent[] | null;
  /** Present on the single-execution export; omitted on the whole-run export. */
  attachments?: PerfettoAttachment[] | null;
}

/** The node-free input the builder turns into a Trace Event Format document. */
export interface PerfettoRunInput {
  run: {
    id: number;
    label?: string | null;
    status?: string | null;
    /** Absolute start time in milliseconds. */
    startTime?: number | null;
    /** Duration in milliseconds. */
    duration?: number | null;
    playwrightVersion?: string | null;
    project?: { id: number; name: string; label?: string | null } | null;
  };
  executions: PerfettoExecution[];
  setupSteps?: PerfettoSetupStep[] | null;
}

/** A single Trace Event Format event. */
export interface TraceEvent {
  name: string;
  cat: string;
  /** Phase: `X` complete, `i` instant, `M` metadata. */
  ph: 'X' | 'i' | 'M';
  /** Timestamp in microseconds. */
  ts: number;
  /** Duration in microseconds (complete events only). */
  dur?: number;
  pid: number;
  tid: number;
  /** Scope of an instant event: `g` global, `p` process, `t` thread. */
  s?: 'g' | 'p' | 't';
  /** Chrome trace color name (good, bad, terrible, yellow, grey). */
  cname?: string;
  args?: Record<string, unknown>;
}

/** The Trace Event Format document. */
export interface PerfettoTrace {
  traceEvents: TraceEvent[];
  displayTimeUnit: 'ms';
  metadata: Record<string, unknown>;
}

export interface PerfettoBuildOptions {
  /** Whole run or one execution — drives the file name and the metadata. */
  scope: 'run' | 'execution';
  /** Dashboard origin used to build execution and attachment URLs. */
  baseUrl?: string | null;
  /** ISO timestamp recorded in the metadata. */
  generatedAt?: string;
  /** Piwi version recorded in the metadata. */
  piwiVersion?: string | null;
}
