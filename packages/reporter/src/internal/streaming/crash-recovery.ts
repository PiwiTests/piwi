import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage } from '../support/errors.js';
import {
  legacyPrivateTempDir,
  privateTempDir,
  readPrivateFile,
  untrustedReason,
  writePrivateFile,
} from '../support/private-file.js';
import { HttpError, deliveredRunId, refusedAsReadOnly, type HttpClient } from '../transport/http-client.js';
import { Logger } from '../support/logger.js';
import { quotaRefusesRun, type StorageQuota } from '../submit/storage-quota.js';

/** What a recovery file holds: one run, and the dashboard it is for. */
interface RecoveryFile {
  v: 1;
  serverUrl: string;
  payload: Record<string, unknown>;
}

/** How many runs, and how many bytes of copies, are kept for one dashboard and project. */
interface RecoveryLimits {
  runs: number;
  bytes: number;
}

/** The copies kept for one dashboard and project: past either limit, the oldest are dropped. */
const RECOVERY_LIMITS: RecoveryLimits = { runs: 20, bytes: 100 * 1024 * 1024 };

/** The start of every recovery file's name. */
const RECOVERY_PREFIX = 'piwi-dashboard-recovery-';

/** A delivery key a copy's file may be named by: the reporter's UUIDs. */
const FILE_KEY = /^[A-Za-z0-9-]{1,64}$/;

/** The dashboard address a recovery file is keyed and checked by: without a trailing slash. */
function recoveryServer(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

/** The key of the copies of a project on one dashboard: the start of a hash of both. */
function recoveryKey(serverUrl: string, projectName: string): string {
  return crypto
    .createHash('sha256')
    .update(`${recoveryServer(serverUrl)}\n${projectName}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The single file in which an older reporter keeps the copy of a project on one dashboard, in `dir` (the reporter's
 * private folder by default): read and replayed beside the copies named by their run's delivery key.
 */
export function singleCopyPath(serverUrl: string, projectName: string, dir: string = privateTempDir()): string {
  return path.join(dir, `${RECOVERY_PREFIX}${recoveryKey(serverUrl, projectName)}.json`);
}

/** The copy of one run of a project on one dashboard, in `dir`, named by the run's delivery key (`fileKey`). */
function runCopyPath(serverUrl: string, projectName: string, fileKey: string, dir: string): string {
  return path.join(dir, `${RECOVERY_PREFIX}${recoveryKey(serverUrl, projectName)}-${fileKey}.json`);
}

/** A copy on disk: its path, its size, when it was written (ms since the epoch) and whether it is the single file. */
interface CopyFile {
  file: string;
  bytes: number;
  at: number;
  single: boolean;
}

/**
 * The copies of a project on one dashboard in `dir`, oldest first: the single file (`singleCopyPath`), which an older
 * reporter wrote, before every run's copy, then the runs' copies by the time each was written. Only those that are a
 * regular file this user alone may write (`untrustedReason`), never through a link.
 */
function listCopies(serverUrl: string, projectName: string, dir: string): CopyFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const single = path.basename(singleCopyPath(serverUrl, projectName, dir));
  const ofRun = `${RECOVERY_PREFIX}${recoveryKey(serverUrl, projectName)}-`;
  const copies: CopyFile[] = [];
  for (const name of names) {
    if (name !== single && !(name.startsWith(ofRun) && name.endsWith('.json'))) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (untrustedReason(stat) === null) {
        copies.push({ file, bytes: stat.size, at: stat.mtimeMs, single: name === single });
      }
    } catch {
      // Replayed and deleted by another run meanwhile.
    }
  }
  return copies.sort((a, b) => Number(b.single) - Number(a.single) || a.at - b.at || a.file.localeCompare(b.file));
}

/** The copies of a project on one dashboard in `dir` (the reporter's private folder by default), oldest first. */
export function recoveryFiles(serverUrl: string, projectName: string, dir: string = privateTempDir()): string[] {
  return listCopies(serverUrl, projectName, dir).map((copy) => copy.file);
}

/** `value` when it is an object, else an empty one. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** An answer of the dashboard that refuses the run itself, which no later try can change. */
function refusesRun(error: unknown): boolean {
  return error instanceof HttpError && [400, 409, 422].includes(error.status);
}

/** A size for a log line: in MB, or KB under one. */
function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Delete `file`; one already gone is fine. */
function remove(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Non-fatal: a later run tries again.
  }
}

/**
 * Persists a test-run payload to disk when all upload strategies fail, so a
 * later run can send it: one file a run, named by its delivery key, readable by
 * its owner only, kept for one dashboard and project within `RECOVERY_LIMITS`,
 * and replayed only to the dashboard it names, oldest first.
 */
export class CrashRecovery {
  private readonly serverUrl: string;
  /** The folder the copies are kept in (`privateTempDir`). */
  private readonly dir: string;
  /** Where an older reporter kept the single file, on Windows (`legacyPrivateTempDir`); `null` elsewhere. */
  private readonly legacyPath: string | null;

  /**
   * @param serverUrl   The dashboard the run is for: its copy is kept for it and replayed to it only.
   * @param projectName With `serverUrl`, the key of the copies.
   * @param logger      Prefixed logger.
   * @param limits      How many runs, and bytes of copies, are kept for the dashboard and project.
   */
  constructor(
    serverUrl: string,
    private readonly projectName: string,
    private readonly logger: Logger = new Logger(),
    private readonly limits: RecoveryLimits = RECOVERY_LIMITS,
  ) {
    this.serverUrl = recoveryServer(serverUrl);
    this.dir = privateTempDir();
    const legacyDir = legacyPrivateTempDir();
    const legacyPath = legacyDir ? singleCopyPath(serverUrl, projectName, legacyDir) : null;
    this.legacyPath = legacyPath !== singleCopyPath(serverUrl, projectName, this.dir) ? legacyPath : null;
  }

  /**
   * Write the run's payload for a later run to send, owner-only, in a file of its own named by its delivery key
   * (`deliveryKey`, else a new one), then drop the oldest copies past the limits (`keepWithinLimits`). True once
   * it is written.
   */
  save(payload: Record<string, unknown>): boolean {
    const key =
      typeof payload.deliveryKey === 'string' && FILE_KEY.test(payload.deliveryKey) ? payload.deliveryKey : null;
    const file = runCopyPath(this.serverUrl, this.projectName, key ?? crypto.randomUUID(), this.dir);
    const saved: RecoveryFile = { v: 1, serverUrl: this.serverUrl, payload };
    try {
      writePrivateFile(file, JSON.stringify(saved));
    } catch (error) {
      this.logger.error(`Failed to save recovery data: ${errorMessage(error)}`);
      return false;
    }
    this.logger.debug('Saved recovery data for later upload');
    this.keepWithinLimits(file);
    return true;
  }

  /**
   * Drop the oldest copies of the dashboard and project, never `kept`, while they hold more runs or bytes than the
   * limits, saying how many runs were dropped.
   */
  private keepWithinLimits(kept: string): void {
    const copies = listCopies(this.serverUrl, this.projectName, this.dir);
    let runs = copies.length;
    let bytes = copies.reduce((sum, copy) => sum + copy.bytes, 0);
    let dropped = 0;
    for (const copy of copies) {
      if (runs <= this.limits.runs && bytes <= this.limits.bytes) break;
      if (copy.file === kept) continue;
      remove(copy.file);
      runs--;
      bytes -= copy.bytes;
      dropped++;
    }
    if (dropped === 0) return;
    this.logger.warn(
      `Dropped the saved results of ${dropped} earlier run${dropped === 1 ? '' : 's'}, the oldest, that the dashboard never got: this machine keeps at most ${this.limits.runs} runs and ${sizeText(this.limits.bytes)} of them for this dashboard and project.`,
    );
  }

  /**
   * The saved payloads, oldest first: each copy that is a regular file this user owns that no one else may write and
   * that names this dashboard. The single file an older reporter left in the shared temp folder on Windows is taken
   * first (`adoptLegacyFile`).
   */
  load(): Record<string, unknown>[] {
    this.adoptLegacyFile();
    return recoveryFiles(this.serverUrl, this.projectName, this.dir)
      .map((file) => this.readPayload(file))
      .filter((payload): payload is Record<string, unknown> => payload !== null);
  }

  /** The payload of the recovery file at `file`, under the checks `load` names; null when it fails one. */
  private readPayload(file: string): Record<string, unknown> | null {
    try {
      const read = readPrivateFile(file);
      if (!read || !('text' in read)) return null;
      const saved = JSON.parse(read.text) as Partial<RecoveryFile> | null;
      if (saved?.v !== 1 || saved.serverUrl !== this.serverUrl) return null;
      return saved.payload && typeof saved.payload === 'object' ? saved.payload : null;
    } catch {
      return null;
    }
  }

  /**
   * Move the single file an older reporter left in the shared temp folder on Windows into the private folder, when
   * the private folder holds no single file and it passes the checks `load` names, keeping when it was written, then
   * delete it there: it is replayed from the private folder from then on. A file that fails them stays where it is.
   */
  private adoptLegacyFile(): void {
    if (!this.legacyPath) return;
    const single = singleCopyPath(this.serverUrl, this.projectName, this.dir);
    try {
      if (fs.lstatSync(single, { throwIfNoEntry: false })) return;
      const written = fs.lstatSync(this.legacyPath, { throwIfNoEntry: false })?.mtime;
      const payload = this.readPayload(this.legacyPath);
      if (!payload || !written) return;
      const file: RecoveryFile = { v: 1, serverUrl: this.serverUrl, payload };
      writePrivateFile(single, JSON.stringify(file));
      fs.lutimesSync(single, written, written);
      fs.rmSync(this.legacyPath, { force: true });
      this.logger.debug(`Moved the saved test data of an older reporter from ${this.legacyPath}`);
    } catch (error) {
      this.logger.debug(`Saved test data of an older reporter left in ${this.legacyPath}: ${errorMessage(error)}`);
    }
  }

  /**
   * Submit the saved copies to the dashboard they were saved for, oldest first, one at a time. A copy is deleted once
   * the dashboard took its run, or refused that run for good, and the next one goes. Any other failure keeps it and
   * the copies after it for a later run: a refusal as the dashboard is read-only, one for its storage quota (which
   * refuses this run too in `storageQuota`, when given: the dashboard refuses new runs; a run the global setup
   * registered goes on, so its caller gives none), a sign-in refused, or no answer. A dashboard already read-only
   * (`HttpClient.readOnly`) is sent nothing.
   */
  async tryUpload(httpClient: HttpClient, auth?: string | null, storageQuota?: StorageQuota): Promise<void> {
    this.adoptLegacyFile();
    const copies = recoveryFiles(this.serverUrl, this.projectName, this.dir);
    if (copies.length === 0 || httpClient.readOnly || recoveryServer(httpClient.baseUrl) !== this.serverUrl) return;

    this.logger.info(
      copies.length === 1
        ? 'Found saved test data from a previous run, uploading...'
        : `Found saved test data from ${copies.length} previous runs, uploading them oldest first...`,
    );
    for (const file of copies) {
      if (!(await this.replay(file, httpClient, auth, storageQuota))) return;
    }
  }

  /** Submit the copy at `file`, as `tryUpload` says; true when the next copy may go. */
  private async replay(
    file: string,
    httpClient: HttpClient,
    auth: string | null | undefined,
    storageQuota: StorageQuota | undefined,
  ): Promise<boolean> {
    const data = this.readPayload(file);
    if (!data) return true;

    // Strip instanceId so /submit doesn't cancel the current run (which shares
    // the same instanceId for the same project + hostname combination).
    delete data.instanceId;
    // The dashboard shows the run was delivered late, from this saved copy, with the files the copy counts as not kept.
    const metadata = asRecord(data.metadata);
    data.metadata = {
      ...metadata,
      ingestHealth: { ...asRecord(metadata.ingestHealth), submitFallback: { path: 'recovery' } },
    };

    try {
      deliveredRunId(await httpClient.postJSON('/api/test-runs/submit', data, auth), '/api/test-runs/submit');
      this.logger.info('Successfully uploaded saved test data');
      remove(file);
      return true;
    } catch (error) {
      if (refusedAsReadOnly(error)) {
        this.logger.info(
          'The dashboard is read-only: the saved test data of earlier runs is not sent, and stays on this machine for a later run.',
        );
        return false;
      }
      if (quotaRefusesRun(error)) {
        storageQuota?.refuseRun();
        this.logger.info(
          'The dashboard refused the saved test data for its storage quota: it stays on this machine for a later run.',
        );
        return false;
      }
      if (refusesRun(error)) {
        this.logger.warn(`The dashboard refused the saved test data, which is deleted: ${errorMessage(error)}`);
        remove(file);
        return true;
      }
      this.logger.warn(`Could not upload saved test data: ${errorMessage(error)}`);
      return false;
    }
  }
}
