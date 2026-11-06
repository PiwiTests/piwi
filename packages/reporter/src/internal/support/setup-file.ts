import * as path from 'node:path';
import * as fs from 'node:fs';
import { hashForProject } from './instance-id.js';
import { Logger } from './logger.js';
import { privateTempDir, readPrivateFile, writePrivateFile } from './private-file.js';

const logger = new Logger();
/** The setup files a warning already named, so a run says once why it ignores one. */
const warnedFiles = new Set<string>();

/**
 * The temp file the global setup hands its registration to the reporter through, or why it has none, per project and
 * per process.
 * Playwright runs the global setup and the reporters in one process, its runner's, so a run reads its own
 * registration alone, whatever other run of the project the machine runs meanwhile.
 */
export function getSetupFilePath(projectName: string, pid: number = process.pid): string {
  return path.join(privateTempDir(), `piwi-dashboard-setup-${hashForProject(projectName)}-${pid}.json`);
}

/** Information saved by the global setup for the reporter instance to consume */
export interface SetupInfo {
  /** Server-assigned run ID */
  runId: number;
  /** One-time token used to authenticate the /begin call */
  setupToken: string;
  /** Project name this run belongs to */
  projectName: string;
  /** The run's live view key, when the project turned its live view on: the workers' alone, set in `onBegin`. */
  liveViewKey?: string;
  /** The instance gives no key since no teammate reaches it: the desktop app on this machine. */
  liveViewLocal?: true;
  /** The run's page, as the global setup printed it (`answeredRunUrl`). */
  runUrl?: string;
}

/** What the global setup leaves in the file when it could not register the run: why, in its error's words. */
interface SetupFailure {
  projectName: string;
  failed: string;
}

/** Write this process's setup info file, readable by its owner alone, replacing whatever was at its path. */
export function writeSetupInfo(info: SetupInfo): void {
  writePrivateFile(getSetupFilePath(info.projectName), JSON.stringify(info));
}

/**
 * Write in this process's setup file that the global setup could not register the run, and why, for the reporter to
 * say. Never throws.
 */
export function writeSetupFailure(projectName: string, failed: string): void {
  const failure: SetupFailure = { projectName, failed };
  try {
    writePrivateFile(getSetupFilePath(projectName), JSON.stringify(failure));
  } catch {
    /* ignore */
  }
}

/**
 * This process's setup file for the given project, left in place: a registration or a failure. `null` when there is
 * none, and when it is not a regular file this user owns that no one else may write (`readPrivateFile`), which one
 * warning names.
 */
function peekSetupFile(projectName: string): Partial<SetupInfo & SetupFailure> | null {
  const setupFile = getSetupFilePath(projectName);
  try {
    const read = readPrivateFile(setupFile);
    if (read && 'untrusted' in read) {
      if (!warnedFiles.has(setupFile)) {
        warnedFiles.add(setupFile);
        logger.warn(`Ignoring the global setup's run registration in ${setupFile}: ${read.untrusted}.`);
      }
      return null;
    }
    const info = read ? JSON.parse(read.text) : null;
    if (info?.projectName === projectName) return info;
  } catch {
    /* ignore */
  }
  return null;
}

/** Read this process's registration of the given project, and leave it in place. `null` when the file holds none. */
export function peekSetupInfo(projectName: string): SetupInfo | null {
  const info = peekSetupFile(projectName);
  return info?.runId && info.setupToken ? (info as SetupInfo) : null;
}

/** Why the global setup of this process could not register the given project's run; `null` when it said nothing so. */
export function peekSetupFailure(projectName: string): string | null {
  const failed = peekSetupFile(projectName)?.failed;
  return typeof failed === 'string' ? failed : null;
}

/** Read and delete this process's setup file for the given project: its registration, `null` when it holds none. */
export function readSetupInfo(projectName: string): SetupInfo | null {
  const info = peekSetupInfo(projectName);
  try {
    fs.unlinkSync(getSetupFilePath(projectName));
  } catch {
    /* ignore */
  }
  return info;
}
