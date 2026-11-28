import { HttpError } from '../transport/http-client.js';
import { Logger } from '../support/logger.js';

/** The code of the dashboard's refusal of a run's files: its storage is at its quota, and it keeps the results alone. */
const FILES_REFUSED = 'STORAGE_QUOTA_FILES_REFUSED';
/** The code of the dashboard's refusal of a new run: its storage is past its quota and the ceiling above it. */
const RUN_REFUSED = 'STORAGE_QUOTA_EXCEEDED';

const FREES_SPACE =
  'A shorter retention on the dashboard frees space, and a higher quota (PIWI_STORAGE_QUOTA_BYTES where the dashboard runs) raises the limit.';

/** Said once a run, when the dashboard keeps the run's results and refuses its files. */
const FILES_REFUSED_WARNING = `The dashboard's storage quota is reached: it keeps this run's results, but not its traces, videos, screenshots or reports, so none are sent for the rest of the run. ${FREES_SPACE}`;

/** Said once a run, when the dashboard refuses the run. */
const RUN_REFUSED_WARNING = `The dashboard refused this run: its storage is past its quota, and past the ceiling at which it refuses new runs. The tests and the run's exit code are not affected, and nothing of this run is sent. ${FREES_SPACE}`;

/** Said when the dashboard refuses the batch delivery of a run it holds from the run's stream. */
const STREAMED_REST_REFUSED_WARNING = `The dashboard kept what this run streamed and refused the rest: its storage is past its quota. The run's data is saved on this machine for a later run to send once the dashboard has room. ${FREES_SPACE}`;

/** Whether the dashboard refused a request's files for its storage quota (409, `STORAGE_QUOTA_FILES_REFUSED`). */
export function quotaRefusesFiles(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409 && error.errorCode === FILES_REFUSED;
}

/** Whether the dashboard refused to create a run for its storage quota (409, `STORAGE_QUOTA_EXCEEDED`). */
export function quotaRefusesRun(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409 && error.errorCode === RUN_REFUSED;
}

/**
 * What the reporter did not send for the storage quota, as the run's `metadata.ingestHealth` counts it: a count is
 * there only when it is above 0. Videos and screenshots are attachments.
 */
export interface FilesNotKept {
  tracesNotKept?: number;
  attachmentsNotKept?: number;
  reportsNotKept?: number;
}

/**
 * The dashboard's storage quota, as it answered this run: whether it refuses the run's files, or the run itself, and
 * the files the reporter did not send since. One instance a run, shared by every request that sends the run or its
 * files, so each refusal is said once and each file counted once.
 */
export class StorageQuota {
  private files = false;
  private run = false;
  private traces = 0;
  private attachments = 0;
  private reports = 0;
  /** The tests and reports counted already. */
  private readonly counted = new WeakSet<object>();

  constructor(private readonly logger: Logger = new Logger()) {}

  /** Whether the dashboard refused the run's files: none is sent for the rest of the run. */
  get refusesFiles(): boolean {
    return this.files;
  }

  /** Whether the dashboard refused the run: nothing of it is sent, and no copy is saved for a later run. */
  get refusesRun(): boolean {
    return this.run;
  }

  /** The dashboard refused the run's files: said once a run. */
  refuseFiles(): void {
    if (this.files) return;
    this.files = true;
    this.logger.warn(FILES_REFUSED_WARNING);
  }

  /** The dashboard refused the run: said once a run, and not at all when `told` (the global setup said it). */
  refuseRun(told = false): void {
    if (this.run) return;
    this.run = true;
    if (!told) this.logger.warn(RUN_REFUSED_WARNING);
  }

  /**
   * The dashboard refused the batch delivery of a run it holds from the run's stream: the run is not refused, what it
   * streamed stays, and the rest goes in the recovery copy, which the caller saves.
   */
  refuseRestOfStreamedRun(): void {
    this.logger.warn(STREAMED_REST_REFUSED_WARNING);
  }

  /**
   * Read an upload's answer: one that kept the results and none of the files (`filesNotKept`) refuses the run's files
   * from then on. The dashboard counts the files it did not keep itself.
   */
  readAnswer(answer: unknown): void {
    const notKept = (answer as { filesNotKept?: { errorCode?: unknown } | null } | null)?.filesNotKept;
    if (notKept?.errorCode === FILES_REFUSED) this.refuseFiles();
  }

  /** Count a test's `traces` and `attachments` the reporter did not send, once a test. */
  leaveOutCase(testCase: object, traces: number, attachments: number): void {
    if (this.counted.has(testCase)) return;
    this.counted.add(testCase);
    this.traces += traces;
    this.attachments += attachments;
  }

  /** Count `reports` the reporter did not send, each once. */
  leaveOutReports(reports: readonly object[]): void {
    for (const report of reports) {
      if (this.counted.has(report)) continue;
      this.counted.add(report);
      this.reports++;
    }
  }

  /** What the reporter did not send so far; null when it left nothing out. */
  notKept(): FilesNotKept | null {
    const counts: FilesNotKept = {
      ...(this.traces > 0 && { tracesNotKept: this.traces }),
      ...(this.attachments > 0 && { attachmentsNotKept: this.attachments }),
      ...(this.reports > 0 && { reportsNotKept: this.reports }),
    };
    return Object.keys(counts).length > 0 ? counts : null;
  }
}
