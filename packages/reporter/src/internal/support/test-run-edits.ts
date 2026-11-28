/**
 * What the reporter's `preprocess` shares between the edits it makes to Playwright's run through its `TestRun`
 * (Playwright 1.62 and later): one deadline for every request it makes to the dashboard, since Playwright starts no
 * test before `preprocess` returns, the sign-in and the project those requests are made with, and the tests a
 * `TestRun` can change.
 */
import type { FullConfig, Suite, TestCase } from '@playwright/test/reporter';
import type { HttpClient } from '../transport/http-client.js';

/** The longest `preprocess` waits for the dashboard, in ms. */
export const PREPROCESS_DEADLINE_MS = 10_000;

/** What a request of `preprocess` is made with: the client, its sign-in, the project, and the deadline's signal. */
export interface DashboardAsk {
  http: HttpClient;
  auth: string | null;
  projectId: number;
  signal: AbortSignal;
}

/**
 * A signal that aborts once `ms` have passed, its reason naming the wait; `clear` stops its clock. The clock holds no
 * process open.
 */
export function deadline(ms: number = PREPROCESS_DEADLINE_MS): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`the dashboard did not answer within ${Math.round(ms / 1000)} s`)),
    ms,
  );
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** `promise`'s outcome, or the signal's reason once it aborts first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Sign in and find the project by its name on the dashboard, before `signal` aborts. */
export async function openDashboardAsk(
  http: HttpClient,
  options: { apiKey?: string | null; username?: string | null; password?: string | null; projectName?: string },
  signal: AbortSignal,
): Promise<DashboardAsk> {
  const auth = await untilAborted(http.resolveAuth(options), signal);
  const name = options.projectName ?? '';
  const menu = (await http.readJSON('/api/projects/menu', auth, signal)) as {
    items?: Array<{ id?: unknown; name?: unknown }>;
  } | null;
  const project = menu?.items?.find((p) => typeof p.name === 'string' && p.name.toLowerCase() === name.toLowerCase());
  if (typeof project?.id !== 'number') throw new Error(`the dashboard has no project named "${name}" yet`);
  return { http, auth, projectId: project.id, signal };
}

/**
 * The names of the run's setup and teardown projects: those another project of the run depends on, or tears down
 * after, directly or not. Playwright runs their tests in full, and its `TestRun` refuses to change them.
 */
export function setupProjects(config: Pick<FullConfig, 'projects'>, root: Suite): Set<string> {
  const byName = new Map((config.projects ?? []).map((project) => [project.name, project] as const));
  const next = (name: string): string[] => {
    const project = byName.get(name) as { dependencies?: string[]; teardown?: string } | undefined;
    return [...(project?.dependencies ?? []), ...(project?.teardown ? [project.teardown] : [])];
  };
  const out = new Set<string>();
  const pending = root.suites.flatMap((suite) => next(suite.title));
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (out.has(name)) continue;
    out.add(name);
    pending.push(...next(name));
  }
  return out;
}

/** The project suites of the run a `TestRun` can change: every one but its setup and teardown projects'. */
export function changeableProjects(config: Pick<FullConfig, 'projects'>, root: Suite): Suite[] {
  const setup = setupProjects(config, root);
  return root.suites.filter((suite) => !setup.has(suite.title));
}

/** The tests of the run a `TestRun` can change, in the order Playwright built them. */
export function changeableTests(config: Pick<FullConfig, 'projects'>, root: Suite): TestCase[] {
  return changeableProjects(config, root).flatMap((suite) => suite.allTests());
}
