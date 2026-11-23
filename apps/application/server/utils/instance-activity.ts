import { routePath } from './body-limit';

/** A count of things open at once: `open` adds one and answers a function that takes it away again, once. */
function openCount() {
  let count = 0;
  return {
    open(): () => void {
      count++;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        count--;
      };
    },
    get value(): number {
      return count;
    },
  };
}

/**
 * The requests of this process that receive a run's results or files, or end a run, until they answer
 * (`RUN_REQUEST_ROUTES`). A restart cuts them.
 */
export const runRequests = openCount();

/**
 * The event streams this process holds open through `openStream` and `createSSEEndpoint`: the streams of pages, live
 * views, connected apps and the desktop app, which reconnect after a restart.
 */
export const eventStreams = openCount();

/**
 * The routes counted in `runRequests`: the reporter's submit, uploads, case files, coverage and end (`/finish`, which
 * answers once the run's end-of-run work is done), an import, a local import in the desktop app, a project's coverage
 * report and a bug report.
 */
const RUN_REQUEST_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/test-runs\/submit$/ },
  { method: 'POST', path: /^\/api\/test-runs\/upload(?:\/results)?$/ },
  { method: 'POST', path: /^\/api\/test-runs\/import$/ },
  { method: 'POST', path: /^\/api\/test-runs\/[^/]+\/case-files$/ },
  { method: 'PUT', path: /^\/api\/test-runs\/[^/]+\/coverage$/ },
  { method: 'POST', path: /^\/api\/test-runs\/[^/]+\/finish$/ },
  { method: 'POST', path: /^\/api\/desktop\/import-(?:local|bug-report)$/ },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/(?:coverage-reports|bug-reports)$/ },
];

/** Whether a request is counted in `runRequests` while it lasts. */
export function isRunRequest(method: string, path: string): boolean {
  const route = routePath(path);
  return RUN_REQUEST_ROUTES.some((counted) => counted.method === method.toUpperCase() && counted.path.test(route));
}
