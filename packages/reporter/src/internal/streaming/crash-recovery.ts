import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage } from '../support/errors.js';
import { legacyPrivateTempDir, privateTempDir, readPrivateFile, writePrivateFile } from '../support/private-file.js';
import { HttpError, deliveredRunId, type HttpClient } from '../transport/http-client.js';
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

/** The recovery file of a project on one dashboard, in `dir`: by default the reporter's private folder. */
export function recoveryFilePath(serverUrl: string, projectName: string, dir: string = privateTempDir()): string {
  const key = crypto
    .createHash('sha256')
    .update(`${recoveryServer(serverUrl)}\n${projectName}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(dir, `piwi-dashboard-recovery-${key}.json`);
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
  /** Where an older reporter kept this file, on Windows (`legacyPrivateTempDir`); `null` elsewhere. */
  private readonly legacyPath: string | null;

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
    const legacyDir = legacyPrivateTempDir();
    const legacyPath = legacyDir ? recoveryFilePath(serverUrl, projectName, legacyDir) : null;
    this.legacyPath = legacyPath !== this.filePath ? legacyPath : null;
  }

  /** Write the payload for a later retry, owner-only, replacing the file in one step. */
  save(payload: Record<string, unknown>): void {
    const file: RecoveryFile = { v: 1, serverUrl: this.serverUrl, payload };
    try {
      writePrivateFile(this.filePath, JSON.stringify(file));
      this.logger.debug('Saved recovery data for later upload');
    } catch (error) {
      this.logger.error(`Failed to save recovery data: ${errorMessage(error)}`);
    }
  }

  /**
   * The saved payload, or null when there is none, or when the file is not a
   * regular file this user owns that no one else may write, or names another dashboard.
   * Without a file of its own, it takes the one an older reporter left (`adoptLegacyFile`).
   */
  load(): Record<string, unknown> | null {
    this.adoptLegacyFile();
    return this.readPayload(this.filePath);
  }

  /** The payload of the recovery file at `file`, under the checks `load` names. */
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
   * Move the recovery file an older reporter left in the shared temp folder on Windows into the private folder, when
   * the private folder holds none and it passes the checks `load` names, then delete it there: it is replayed from
   * the private folder from then on. A file that fails them stays where it is.
   */
  private adoptLegacyFile(): void {
    if (!this.legacyPath) return;
    try {
      if (fs.lstatSync(this.filePath, { throwIfNoEntry: false })) return;
      const payload = this.readPayload(this.legacyPath);
      if (!payload) return;
      const file: RecoveryFile = { v: 1, serverUrl: this.serverUrl, payload };
      writePrivateFile(this.filePath, JSON.stringify(file));
      fs.rmSync(this.legacyPath, { force: true });
      this.logger.debug(`Moved the saved test data of an older reporter from ${this.legacyPath}`);
    } catch (error) {
      this.logger.debug(`Saved test data of an older reporter left in ${this.legacyPath}: ${errorMessage(error)}`);
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
      deliveredRunId(await httpClient.postJSON('/api/test-runs/submit', data, auth), '/api/test-runs/submit');
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
