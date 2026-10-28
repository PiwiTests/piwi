import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { hashForProject } from './instance-id.js';

/** Return the temp-file path used to exchange setup info between globalSetup and the reporter instance */
export function getSetupFilePath(projectName: string): string {
  return path.join(os.tmpdir(), `piwi-dashboard-setup-${hashForProject(projectName)}.json`);
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

/** Write the setup info file, readable by its owner alone. */
export function writeSetupInfo(info: SetupInfo): void {
  const setupFile = getSetupFilePath(info.projectName);
  fs.writeFileSync(setupFile, JSON.stringify(info), { mode: 0o600 });
}

/** Read the setup info file for the given project, and leave it in place. Returns `null` when no file exists. */
export function peekSetupInfo(projectName: string): SetupInfo | null {
  const setupFile = getSetupFilePath(projectName);
  try {
    if (fs.existsSync(setupFile)) {
      const info = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
      if (info.projectName === projectName) return info;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Read and delete the setup info file for the given project. Returns `null` when no file exists. */
export function readSetupInfo(projectName: string): SetupInfo | null {
  const info = peekSetupInfo(projectName);
  try {
    fs.unlinkSync(getSetupFilePath(projectName));
  } catch {
    /* ignore */
  }
  return info;
}
