/**
 * The routes of a run target (`./run-target.ts`) under `/api/desktop/run-target`, framework-neutral: each takes a
 * request (its headers, cookies, path id and parsed body) and answers a status and a body. A host adapts them to its
 * framework (the desktop app's Nitro routes, `./run-target-http.ts`) after its guard took the access token
 * (`./host-guard.ts`); the routes check the body and refuse a browser on the shell-only routes, so every host answers
 * the same.
 */
import { isBrowserRequest, type HostRequest } from './host-guard';
import { mintSessionCode } from './run-target-session';
import {
  answerRunRequest,
  connectRunTarget,
  disconnectRunTarget,
  instanceUrlOf,
  isRequestId,
  keyToKeep,
  localRunsOf,
  launchOf,
  linksOf,
  planAgain,
  requestedRunEnded,
  requestedRunFailed,
  requestedRunStarted,
  runTargetConnection,
  useKeptKey,
  useLinks,
  useLocalRuns,
  waitingRunRequests,
} from './run-target';

/** The path every run-target route sits under. */
export const RUN_TARGET_BASE = '/api/desktop/run-target';

/** A request to a run-target route. */
export interface RunTargetRequest extends HostRequest {
  /** The request id of a `/requests/:id/…` route. */
  id?: string;
  /** The parsed JSON body, or null. */
  body: unknown;
}

/** A route's answer: an error's body is `{ message }`. */
export interface RunTargetAnswer {
  status: number;
  body: unknown;
  /** Whether the answer must not be cached (`Cache-Control: no-store`). */
  noStore: boolean;
}

interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** The path after `RUN_TARGET_BASE`, `:id` standing for a request id. */
  path: string;
  /** Called by the desktop shell alone: a browser's request is refused. */
  shellOnly: boolean;
  handle(request: RunTargetRequest): Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
}

const ok = (body: unknown) => ({ status: 200, body });
const refused = (status: number, message: string) => ({ status, body: { message } });
const bodyOf = (request: RunTargetRequest) =>
  (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
const TARGET_KEY = /^pd_[0-9a-f]{16,128}$/;

export const RUN_TARGET_ROUTES = {
  /** The connection and the requests the window asks about. */
  status: {
    method: 'GET',
    path: '',
    shellOnly: false,
    handle: () => ok({ connection: runTargetConnection(), requests: waitingRunRequests() }),
  },
  /** Start the device flow on an instance. */
  connect: {
    method: 'POST',
    path: '/connect',
    shellOnly: false,
    handle: async (request) => {
      const instance = instanceUrlOf(bodyOf(request).instance);
      if (!instance) return refused(400, 'The instance is an http or https URL');
      return ok(await connectRunTarget(instance));
    },
  },
  /** The key the device flow gave, for the shell to keep. */
  keepKey: {
    method: 'POST',
    path: '/key',
    shellOnly: true,
    handle: () => {
      const kept = keyToKeep();
      return kept ? ok(kept) : refused(404, 'No key to keep');
    },
  },
  /** The code the window's session bootstrap takes once (`./run-target-session.ts`), for the shell to put in its URL. */
  sessionCode: {
    method: 'POST',
    path: '/session-code',
    shellOnly: true,
    handle: () => ok({ code: mintSessionCode() }),
  },
  /**
   * The kept key, the linked folders, the requested runs the shell still holds and the folders its local runs are
   * going in, from the shell after each start.
   */
  useKey: {
    method: 'PUT',
    path: '/key',
    shellOnly: true,
    handle: (request) => {
      const body = bodyOf(request);
      const instance = instanceUrlOf(body.instance);
      const links = linksOf(body.links ?? {});
      const running = body.running ?? [];
      const localRuns = localRunsOf(body.localRuns ?? []);
      if (
        !instance ||
        typeof body.key !== 'string' ||
        !TARGET_KEY.test(body.key) ||
        !links ||
        !Array.isArray(running) ||
        running.length > 200 ||
        !running.every(isRequestId) ||
        !localRuns
      ) {
        return refused(400, 'Invalid instance, key, links or runs');
      }
      useKeptKey(instance, body.key, links, running, { localRuns });
      return ok({ ok: true });
    },
  },
  /** Disconnect. */
  forgetKey: {
    method: 'DELETE',
    path: '/key',
    shellOnly: true,
    handle: () => {
      disconnectRunTarget();
      return ok({ ok: true });
    },
  },
  /** The folders linked to the instance's projects. */
  links: {
    method: 'PUT',
    path: '/links',
    shellOnly: true,
    handle: (request) => {
      const links = linksOf(bodyOf(request).links);
      if (!links) return refused(400, 'Invalid links');
      useLinks(links);
      return ok({ ok: true });
    },
  },
  /** The folders the shell's local runs are going in, whenever they change. */
  localRuns: {
    method: 'PUT',
    path: '/local-runs',
    shellOnly: true,
    handle: (request) => {
      const folders = localRunsOf(bodyOf(request).folders);
      if (!folders) return refused(400, 'Invalid folders');
      useLocalRuns(folders);
      return ok({ ok: true });
    },
  },
  /** Check a request again, after the person linked its folder. */
  plan: {
    method: 'POST',
    path: '/requests/:id/plan',
    shellOnly: false,
    handle: async (request) => {
      const prompt = await planAgain(request.id!);
      return prompt ? ok(prompt) : refused(404, 'This request is no longer asked about');
    },
  },
  /** The person's answer in the window. */
  answer: {
    method: 'POST',
    path: '/requests/:id/answer',
    shellOnly: false,
    handle: async (request) => {
      const { decision, command } = bodyOf(request);
      if (decision !== 'run' && decision !== 'not-now') return refused(400, 'The decision is run or not-now');
      const answered = await answerRunRequest(request.id!, decision, typeof command === 'string' ? command : null);
      return answered.ok ? ok({ launch: answered.launch }) : refused(answered.statusCode, answered.message);
    },
  },
  /** What the shell starts after **Run**, once. */
  launch: {
    method: 'POST',
    path: '/requests/:id/launch',
    shellOnly: true,
    handle: (request) => {
      const launch = launchOf(request.id!);
      return launch ? ok(launch) : refused(404, 'No run to start for this request');
    },
  },
  /** The shell started the run, or could not. */
  started: {
    method: 'POST',
    path: '/requests/:id/started',
    shellOnly: true,
    handle: async (request) => {
      const { error } = bodyOf(request);
      if (typeof error === 'string' && error) await requestedRunFailed(request.id!, error);
      else await requestedRunStarted(request.id!);
      return ok({ ok: true });
    },
  },
  /** The run ended, with its exit code. */
  ended: {
    method: 'POST',
    path: '/requests/:id/ended',
    shellOnly: true,
    handle: async (request) => {
      const { code, stopped } = bodyOf(request);
      await requestedRunEnded(
        request.id!,
        typeof code === 'number' && Number.isInteger(code) ? code : null,
        stopped === true,
      );
      return ok({ ok: true });
    },
  },
} as const satisfies Record<string, RouteDef>;

export type RunTargetRouteName = keyof typeof RUN_TARGET_ROUTES;

/** Whether a request's `Content-Type` is `application/json`, parameters (`charset`) aside and in any case. */
export function isJsonRequest(request: Pick<HostRequest, 'headers'>): boolean {
  return request.headers['content-type']?.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

/** Whether a method's request carries a JSON body, which `answerRunTargetRoute` reads: every method but GET and DELETE. */
export function sendsBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'DELETE';
}

/**
 * Why a request to a route is refused before its body is read, or null: a browser's request to a shell-only route
 * (403); a POST or PUT whose content type is not `application/json` (415); an id under `/requests/:id` that is not a
 * request id (400). The 415 and 400 refusals of a shell-only route are `noStore`.
 */
export function refuseRunTargetRequest(
  name: RunTargetRouteName,
  request: Omit<RunTargetRequest, 'body'>,
): RunTargetAnswer | null {
  const route: RouteDef = RUN_TARGET_ROUTES[name];
  if (route.shellOnly && isBrowserRequest(request)) {
    return { ...refused(403, 'The desktop shell alone calls this route'), noStore: false };
  }
  const noStore = route.shellOnly || name === 'status';
  if (sendsBody(route.method) && !isJsonRequest(request)) {
    return { ...refused(415, 'The body is application/json'), noStore };
  }
  if (route.path.includes(':id') && !isRequestId(request.id)) {
    return { ...refused(400, 'Invalid request id'), noStore };
  }
  return null;
}

/** Answer one run-target route: the refusal of `refuseRunTargetRequest`, else the route's own answer. */
export async function answerRunTargetRoute(
  name: RunTargetRouteName,
  request: RunTargetRequest,
): Promise<RunTargetAnswer> {
  const refusal = refuseRunTargetRequest(name, request);
  if (refusal) return refusal;
  const route: RouteDef = RUN_TARGET_ROUTES[name];
  const noStore = route.shellOnly || name === 'status';
  return { ...(await route.handle(request)), noStore };
}

/** The path of a request URL, without its query and a trailing slash. */
export function pathnameOf(url: string): string {
  return url.split('?')[0]!.replace(/(.)\/$/, '$1');
}

/** The route a method and a path name, with the request id of a `/requests/:id` path; null for none. */
export function matchRunTargetRoute(method: string, path: string): { name: RunTargetRouteName; id?: string } | null {
  const pathname = pathnameOf(path);
  if (pathname !== RUN_TARGET_BASE && !pathname.startsWith(`${RUN_TARGET_BASE}/`)) return null;
  const rest = pathname.slice(RUN_TARGET_BASE.length);
  const id = rest.match(/^\/requests\/([^/]+)\//)?.[1];
  const shape = id === undefined ? rest : rest.replace(`/requests/${id}/`, '/requests/:id/');
  for (const [name, route] of Object.entries(RUN_TARGET_ROUTES) as [RunTargetRouteName, RouteDef][]) {
    if (route.method === method.toUpperCase() && route.path === shape) {
      return id === undefined ? { name } : { name, id };
    }
  }
  return null;
}
