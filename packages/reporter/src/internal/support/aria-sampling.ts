import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { TestInfo } from '@playwright/test';
import { hashForProject } from './instance-id.js';
import { configDirFromConfig, relativeTestPath } from './test-paths.js';

/**
 * Green ARIA sampling — deciding, per passing test, whether to capture its page
 * as a fresh "last known good" snapshot.
 *
 * The server owns the schedule: at run start `globalSetup` asks
 * `GET /api/projects/:id/aria-sampling` which tests are due a sample (their
 * newest green snapshot is stale or missing) and writes the answer to a temp
 * file. Each worker reads that file once and keeps the set in memory, so the
 * per-test decision costs nothing. When the file is absent — an old server, a
 * failed call, sampling switched off — the set is null and nothing is sampled.
 */

/** Stable identity for a test, matching how the server keys a test case. */
export function ariaSampleIdentity(filePath: string, title: string): string {
  return `${filePath}\x00${title}`;
}

/** Temp-file path holding the sample set, keyed by project so runs don't collide. */
function getAriaSampleFilePath(projectName: string): string {
  return path.join(os.tmpdir(), `piwi-dashboard-aria-sample-${hashForProject(projectName)}.json`);
}

/** Write the set of due test identities for a project. Best-effort; swallows IO errors. */
export function writeAriaSampleFile(projectName: string, identities: string[]): void {
  try {
    fs.writeFileSync(getAriaSampleFilePath(projectName), JSON.stringify({ projectName, identities }));
  } catch {
    /* a sample set that cannot be written simply means no sampling this run */
  }
}

/** Remove a project's sample file. Called at run start so a stale set never leaks into the next run. */
export function clearAriaSampleFile(projectName: string): void {
  try {
    fs.rmSync(getAriaSampleFilePath(projectName), { force: true });
  } catch {
    /* ignore */
  }
}

// The set is read once per worker and cached, keyed by project name. `null`
// means "no set available" (never sample); a Set means the due identities.
const cachedSets = new Map<string, Set<string> | null>();

/** Load a project's due-identity set from the temp file, cached per worker. */
export function loadAriaSampleSet(projectName: string): Set<string> | null {
  if (cachedSets.has(projectName)) return cachedSets.get(projectName)!;
  let set: Set<string> | null = null;
  try {
    const raw = fs.readFileSync(getAriaSampleFilePath(projectName), 'utf8');
    const parsed = JSON.parse(raw) as { projectName?: string; identities?: unknown };
    if (parsed.projectName === projectName && Array.isArray(parsed.identities)) {
      set = new Set(parsed.identities.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    set = null;
  }
  cachedSets.set(projectName, set);
  return set;
}

/** Clear the per-worker cache. Test-only. */
export function resetAriaSampleCache(): void {
  cachedSets.clear();
}

/**
 * Whether a passing test's page should be sampled. True only when its identity
 * is in the server-provided due set — so a null set (no file, old server, failed
 * call) never samples.
 */
export function isDueForAriaSample(testInfo: TestInfo): boolean {
  const projectName = process.env.PIWI_PROJECT_NAME;
  if (!projectName) return false;
  const set = loadAriaSampleSet(projectName);
  if (!set || set.size === 0) return false;
  return set.has(
    ariaSampleIdentity(relativeTestPath(testInfo.file, configDirFromConfig(testInfo.config)), testInfo.title),
  );
}
