import * as path from 'node:path';
import * as fs from 'node:fs';
import { hashForProject } from './instance-id.js';
import { Logger } from './logger.js';
import { privateTempDir, readPrivateFile, writePrivateFile } from './private-file.js';

const logger = new Logger();
/** The setup files a warning already named, so a run says once why it ignores one. */
const warnedFiles = new Set<string>();

/**
 * The temp file the global setup hands its registration to the reporter through, per project and per process.
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
}

/** Write this process's setup info file, readable by its owner alone, replacing whatever was at its path. */
export function writeSetupInfo(info: SetupInfo): void {
  writePrivateFile(getSetupFilePath(info.projectName), JSON.stringify(info));
}

/**
 * Read this process's setup info file for the given project, and leave it in place. `null` when there is none, and
 * when it is not a regular file this user owns that no one else may write (`readPrivateFile`), which one warning names.
 */
export function peekSetupInfo(projectName: string): SetupInfo | null {
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

/** Read and delete this process's setup info file for the given project. `null` when there is none. */
export function readSetupInfo(projectName: string): SetupInfo | null {
  const info = peekSetupInfo(projectName);
  try {
    fs.unlinkSync(getSetupFilePath(projectName));
  } catch {
    /* ignore */
  }
  return info;
}
