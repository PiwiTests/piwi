import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorMessage } from '../support/errors.js';
import { HttpError, type HttpClient } from '../transport/http-client.js';
import { Logger } from '../support/logger.js';

/** What the recovery file holds: the run, and the dashboard it is for. */
interface RecoveryFile {
  v: 1;
  serverUrl: string;
  payload: Record<string, unknown>;
}

/** The dashboard address a recovery file is keyed and checked by: without a trailing slash. */
function recoveryServer(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

/** The recovery file of a project on one dashboard, in the temp directory. */
export function recoveryFilePath(serverUrl: string, projectName: string): string {
  const key = crypto
    .createHash('sha256')
    .update(`${recoveryServer(serverUrl)}\n${projectName}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), `piwi-dashboard-recovery-${key}.json`);
}

/** An answer of the dashboard that refuses the run itself, which no later try can change. */
function refusesRun(error: unknown): boolean {
  return error instanceof HttpError && [400, 409, 422].includes(error.status);
}

/**
 * Persists a test-run payload to disk when all upload strategies fail, so the
 * next run can send it. The file is keyed by the dashboard and the project,
 * readable by its owner only, and replayed only to the dashboard it names.
 */
export class CrashRecovery {
  private readonly serverUrl: string;
  private readonly filePath: string;

  /**
   * @param serverUrl   The dashboard the run is for: the file is kept for it and replayed to it only.
   * @param projectName With `serverUrl`, the key of the file.
   * @param logger      Prefixed logger.
   */
  constructor(
    serverUrl: string,
    projectName: string,
    private readonly logger: Logger = new Logger(),
  ) {
    this.serverUrl = recoveryServer(serverUrl);
    this.filePath = recoveryFilePath(serverUrl, projectName);
  }

  /** Write the payload for a later retry, owner-only, replacing the file in one step. */
  save(payload: Record<string, unknown>): void {
    const file: RecoveryFile = { v: 1, serverUrl: this.serverUrl, payload };
    const temp = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(file), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, this.filePath);
      this.logger.info('Saved recovery data for later upload');
    } catch (error) {
      fs.rmSync(temp, { force: true });
      this.logger.error(`Failed to save recovery data: ${errorMessage(error)}`);
    }
  }

  /**
   * The saved payload, or null when there is none, or when the file is not a
   * regular file this user owns, or names another dashboard.
   */
  load(): Record<string, unknown> | null {
    let fd: number;
    try {
      fd = fs.openSync(this.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch {
      return null;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
      const file = JSON.parse(fs.readFileSync(fd, 'utf8')) as Partial<RecoveryFile> | null;
      if (file?.v !== 1 || file.serverUrl !== this.serverUrl) return null;
      return file.payload && typeof file.payload === 'object' ? file.payload : null;
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Delete the recovery file from disk */
  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Submit a previously saved payload to the dashboard it was saved for. The
   * file is deleted once the dashboard took the run, or refused it for good;
   * anything else keeps it for the next run.
   */
  async tryUpload(httpClient: HttpClient, auth?: string | null): Promise<void> {
    const data = this.load();
    if (!data || recoveryServer(httpClient.baseUrl) !== this.serverUrl) return;

    this.logger.info('Found saved test data from a previous run, uploading...');

    // Strip instanceId so /submit doesn't cancel the current run (which shares
    // the same instanceId for the same project + hostname combination).
    delete data.instanceId;
    // The dashboard shows the run was delivered late, from this saved copy.
    const metadata =
      data.metadata && typeof data.metadata === 'object' ? (data.metadata as Record<string, unknown>) : {};
    data.metadata = { ...metadata, ingestHealth: { submitFallback: { path: 'recovery' } } };

    try {
      await httpClient.postJSON('/api/test-runs/submit', data, auth);
      this.logger.info('Successfully uploaded saved test data');
      this.clear();
    } catch (error) {
      if (refusesRun(error)) {
        this.logger.warn(`The dashboard refused the saved test data, which is deleted: ${errorMessage(error)}`);
        this.clear();
        return;
      }
      this.logger.warn(`Could not upload saved test data: ${errorMessage(error)}`);
    }
  }
}
