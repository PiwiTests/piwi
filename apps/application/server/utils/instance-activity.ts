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
 * The requests of this process receiving a run's results or files: the reporter's submit, its uploads, its case files
 * and coverage, and an import. A restart cuts them.
 */
export const runUploads = openCount();

/** The event streams this process holds open: pages, live views and connected apps, which reconnect after a restart. */
export const eventStreams = openCount();

const RUN_UPLOAD_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/test-runs\/submit$/ },
  { method: 'POST', path: /^\/api\/test-runs\/upload(?:\/results)?$/ },
  { method: 'POST', path: /^\/api\/test-runs\/import$/ },
  { method: 'POST', path: /^\/api\/test-runs\/[^/]+\/case-files$/ },
  { method: 'PUT', path: /^\/api\/test-runs\/[^/]+\/coverage$/ },
];

/** Whether a request receives a run's results or files, counted in `runUploads` while it lasts. */
export function receivesRunUpload(method: string, path: string): boolean {
  const route = routePath(path);
  return RUN_UPLOAD_ROUTES.some((upload) => upload.method === method.toUpperCase() && upload.path.test(route));
}
