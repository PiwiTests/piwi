/**
 * The request host: a run target's side of **Run on my machine**. It holds the stream a team instance sends a
 * connected app its run requests and stops on (`GET /api/run-targets/stream`), connects again with a growing pause
 * when it ends, lists the requests every minute while it is open (which keeps the app online) and more often while it
 * is not, and makes the target's calls: claim, answer, state, and describe this app. It runs no test and reads no
 * folder: the host of the target (the desktop app's server, Piwi Runner) asks the person, checks the folder
 * (`./request-run`) and starts the run.
 *
 * Every call carries the target's key, which holds `run:receive` alone, as a bearer token, through `instanceFetch`.
 * The device flow that gives the target its key (`postDeviceFlow`) goes through it too, with no key.
 */
import {
  parseRunRequest,
  RUN_REQUEST_ID,
  type RunRequest,
  type RunRequestOffer,
  type RunRequestOutcome,
} from '@piwitests/core/run-request';
import { instanceFetch } from './http';

/** What the target's stream and its list say, in the instance's words. */
type StreamEvent =
  | { type: 'snapshot'; requests: RunRequestOffer[]; stops: string[]; held?: unknown; projects?: unknown }
  | { type: 'request'; request: RunRequestOffer; projects?: unknown }
  | { type: 'stop'; id: string }
  | { type: 'withdrawn'; id: string }
  | { type: 'revoked' };

/** A project's id and the name the instance shows for it. */
export interface ProjectName {
  id: number;
  name: string;
}

/** The longest project name the host passes on. */
const MAX_PROJECT_NAME = 200;

/** The project names in what the instance said, leaving out any that is not an id and a name. */
export function readProjectNames(raw: unknown): ProjectName[] {
  if (!Array.isArray(raw)) return [];
  const names: ProjectName[] = [];
  for (const item of raw.slice(0, 200)) {
    const { id, name } = (item ?? {}) as { id?: unknown; name?: unknown };
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed && trimmed.length <= MAX_PROJECT_NAME) names.push({ id: id as number, name: trimmed });
  }
  return names;
}

/** Where the connection stands. */
export type RequestHostStatus = 'connecting' | 'online' | 'offline' | 'revoked';

export interface RequestHostOptions {
  /** The instance's URL, without a trailing slash. */
  instance: string;
  /** The target's key. */
  key: string;
  /** How this app names itself to the instance, and the projects it has a folder for. */
  describe: () => { platform: string; version: string; projectIds: number[] };
  /** A request offered for the first time, still waiting for a claim. */
  onOffer: (offer: RunRequestOffer) => void;
  /** A request offered earlier that no longer waits: stopped, claimed by another app, or past its time. */
  onWithdrawn: (id: string) => void;
  /** The requester asked to stop a request this target holds. */
  onStop: (id: string) => void;
  /**
   * Whether this app still holds a request the instance counts as this target's: one it asks the person about, or whose
   * run is going. On its first list the host ends each one it does not hold, which the instance kept for an app that
   * started again: unanswered ones are refused, one being stopped ends as stopped and the others as an error.
   */
  holds?: (id: string) => boolean;
  /** The instance named projects this target may take requests for: each one's id and its label, else its name. */
  onProjectNames?: (projects: ProjectName[]) => void;
  /** The connection changed: `revoked` once the key or its app was disconnected, after which the host stops. */
  onStatus?: (status: RequestHostStatus, detail?: string) => void;
  /**
   * The instance said the key no longer exists: its stream's `revoked` event, or a 401 that carries the instance's own
   * message. A 403 stops the host and leaves the key, since it also answers a setting turned off or a permission.
   */
  onKeyRevoked?: () => void;
  /** `fetch` for the instance; `instanceFetch` by default. */
  fetch?: typeof instanceFetch;
  /** The pauses, in milliseconds, so tests can shorten them. */
  timing?: Partial<typeof DEFAULT_TIMING>;
}

/** Why a request the instance counted as this target's ended once the app started again without it. */
const RESTARTED = 'The app started again and no longer holds this request';

/** How long a request token starts a run after **Run**, in milliseconds: the instance's grant, and the target's wait. */
export const REQUEST_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

const DEFAULT_TIMING = {
  /** The first pause before the stream is opened again; each next one doubles, up to `retryLastMs`. */
  retryFirstMs: 2_000,
  retryLastMs: 60_000,
  /** How often the requests are listed while the stream is open: the instance counts the app online for two minutes. */
  pollOpenMs: 60_000,
  /** How often they are listed while it is not, where a proxy cuts long responses. */
  pollClosedMs: 15_000,
  /** How long the stream may stay silent before it is opened again: the instance sends a comment every 15 s. */
  idleMs: 60_000,
};

/** A refusal of a target route, with the instance's status. */
export class RequestHostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether a status says the key or its app no longer counts. */
const isRevokedStatus = (status: number) => status === 401 || status === 403;

/** The `message` of a refusal's JSON body; empty for a body that is not the instance's. */
async function refusalMessage(response: Response): Promise<string> {
  try {
    const message = ((await response.json()) as { message?: unknown } | null)?.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

/**
 * A request as the instance sent it, checked by the one parser, so nothing the target runs comes unchecked from the
 * network. Null when it does not pass.
 */
function readRequest(value: unknown): RunRequest | null {
  const parsed = parseRunRequest(value);
  return parsed.ok ? parsed.value : null;
}

function readOffer(value: unknown): RunRequestOffer | null {
  if (!value || typeof value !== 'object') return null;
  const { expiresAt, ...rest } = value as Record<string, unknown>;
  const request = readRequest(rest);
  return request && typeof expiresAt === 'string' ? { ...request, expiresAt } : null;
}

/**
 * A call of the device flow that connects a target, before it has a key: `body` posted to `path` on `instance`
 * through `instanceFetch`. Answers the status and the JSON answer, `{}` for an answer that is not JSON.
 */
export async function postDeviceFlow(
  instance: string,
  path: '/api/extension/connect' | '/api/extension/connect/token',
  body: unknown,
  fetchImpl: typeof instanceFetch = instanceFetch,
): Promise<{ status: number; answer: Record<string, unknown> }> {
  const response = await fetchImpl(`${instance}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, answer };
}

const isRequestId = (id: unknown): id is string => typeof id === 'string' && RUN_REQUEST_ID.test(id);

/**
 * Call `onData` with the data of each event of a `text/event-stream` body until it ends. Comment lines (the
 * heartbeats) and the other fields are skipped; `onActivity` hears every chunk, comments included.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  onActivity: () => void = () => {},
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let data: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onActivity();
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line === '') {
        if (data.length > 0) onData(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
}

export class RequestHost {
  private readonly options: RequestHostOptions;
  private readonly timing: typeof DEFAULT_TIMING;
  private readonly fetch: typeof instanceFetch;
  /** The requests offered and still waiting, by id, with when they stop waiting. */
  private readonly offered = new Map<string, number>();
  /** When each waiting request was offered, so a list read before an offer never withdraws it. */
  private readonly offeredAt = new Map<string, number>();
  /** The requests this host claimed, which a list read before the claim never offers again. */
  private readonly claimed = new Set<string>();
  /** The stops already told, so a stop listed every minute is told once. */
  private readonly stopsTold = new Set<string>();
  /** Whether the requests the instance counts as held were checked against `holds`, once a start. */
  private reconciled = false;
  /** The latest list asked for: an older one that answers later is left out. */
  private listing = 0;
  private status: RequestHostStatus = 'offline';
  private stopped = false;
  private streamOpen = false;
  private stream: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(options: RequestHostOptions) {
    this.options = options;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.fetch = options.fetch ?? instanceFetch;
  }

  /** Connect: describe this app, open the stream and start listing. */
  start(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    void this.describe().catch(() => {});
    this.openStream();
    this.schedulePoll(this.timing.pollClosedMs);
  }

  /** Disconnect, for good: a new host connects again. */
  close(): void {
    this.stopped = true;
    this.stream?.abort();
    if (this.retry) clearTimeout(this.retry);
    if (this.poll) clearTimeout(this.poll);
    this.retry = this.poll = null;
  }

  /** Claim a request offered here: the instance answers the request, or refuses it once another app claimed it. */
  async claim(id: string): Promise<RunRequest> {
    if (!isRequestId(id)) throw new RequestHostError(404, 'No run request has this id');
    const claimed = readRequest(
      await this.call('POST', `/api/run-targets/requests/${id}/claim`, undefined, { onlyRequest: true }),
    );
    this.claimed.add(id);
    this.offered.delete(id);
    this.offeredAt.delete(id);
    if (!claimed || claimed.id !== id) {
      throw new RequestHostError(422, 'The instance sent a request this version of Piwi cannot read: update it');
    }
    return claimed;
  }

  /**
   * Answer a claimed request with the person's decision: `run` answers the request token that starts its run, once,
   * which the host hands the reporter and never keeps.
   */
  async answer(
    id: string,
    decision: { decision: 'run' } | { decision: 'not-now' } | { decision: 'refused'; detail: string },
  ): Promise<{ requestToken?: string }> {
    if (!isRequestId(id)) throw new RequestHostError(404, 'No run request has this id');
    const answered = await this.call<{ requestToken?: unknown }>(
      'POST',
      `/api/run-targets/requests/${id}/answer`,
      decision,
      { onlyRequest: true },
    );
    return typeof answered.requestToken === 'string' ? { requestToken: answered.requestToken } : {};
  }

  /** Report the next state of a requested run. */
  async report(
    id: string,
    update:
      | { state: 'running' | 'stopping'; detail?: string }
      | { state: 'ended'; outcome: RunRequestOutcome; detail?: string },
  ): Promise<void> {
    if (!isRequestId(id)) throw new RequestHostError(404, 'No run request has this id');
    await this.call('POST', `/api/run-targets/requests/${id}/state`, update, { onlyRequest: true });
  }

  /** Tell the instance this app's platform, version and the projects it has a folder for; it names them back. */
  async describe(): Promise<void> {
    const { platform, version, projectIds } = this.options.describe();
    const described = await this.call<{ projects?: unknown }>('PUT', '/api/run-targets/self', {
      platform,
      version,
      projectIds: projectIds.slice(0, 200),
    });
    if (!this.stopped) this.takeNames(described?.projects);
  }

  /** Where the connection stands now. */
  get state(): RequestHostStatus {
    return this.status;
  }

  /**
   * Call a target route. A 401, or a 403 of a route about this app rather than one request, means its key no longer
   * counts; a request's 403 (the capability turned off, a role changed) refuses that request alone.
   */
  private async call<T = unknown>(
    method: string,
    route: string,
    body?: unknown,
    { onlyRequest = false }: { onlyRequest?: boolean } = {},
  ): Promise<T> {
    const response = await this.fetch(`${this.options.instance}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.key}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const message = await refusalMessage(response);
      if (response.status === 401 || (!onlyRequest && isRevokedStatus(response.status))) {
        this.revoked(message, response.status === 401 && message !== '');
      }
      throw new RequestHostError(response.status, message || `The instance answered ${response.status}`);
    }
    return (await response.json().catch(() => ({}))) as T;
  }

  private setStatus(status: RequestHostStatus, detail?: string): void {
    if (this.status === status || this.status === 'revoked') return;
    this.status = status;
    this.options.onStatus?.(status, detail);
  }

  private revoked(detail?: string, keyGone = false): void {
    if (this.stopped) return;
    this.setStatus('revoked', detail);
    if (keyGone) this.options.onKeyRevoked?.();
    this.close();
  }

  /** Take what the stream or the list says. */
  private take(event: StreamEvent): void {
    if (this.stopped) return;
    switch (event.type) {
      case 'snapshot':
        this.takeNames(event.projects);
        this.takeList(event.requests, event.stops, Number.POSITIVE_INFINITY, event.held);
        break;
      case 'request':
        this.takeNames(event.projects);
        this.offer(event.request);
        break;
      case 'stop':
        if (isRequestId(event.id)) this.tellStop(event.id);
        break;
      case 'withdrawn':
        if (isRequestId(event.id)) this.withdraw(event.id);
        break;
      case 'revoked':
        this.revoked(undefined, true);
        break;
    }
  }

  private takeNames(raw: unknown): void {
    const names = readProjectNames(raw);
    if (names.length) this.options.onProjectNames?.(names);
  }

  /** Take a list of the requests read at `askedAt`: an offer made since then stays, whatever the list says. */
  private takeList(requests: unknown, stops: unknown, askedAt: number, held?: unknown): void {
    this.reconcile(held);
    const offers = Array.isArray(requests) ? requests : [];
    const stopIds = (Array.isArray(stops) ? stops : []).filter(isRequestId);
    const listed = new Set<string>();
    for (const raw of offers) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (isRequestId(id)) listed.add(id);
      this.offer(raw);
    }
    // A request offered earlier that the list no longer holds waits no more.
    for (const id of Array.from(this.offered.keys())) {
      if (!listed.has(id) && (this.offeredAt.get(id) ?? 0) < askedAt) this.withdraw(id);
    }
    for (const id of stopIds) this.tellStop(id);
    for (const id of Array.from(this.stopsTold)) if (!stopIds.includes(id)) this.stopsTold.delete(id);
  }

  /**
   * End the requests the instance counts as this target's that this app no longer holds, on the first list that names
   * them. An instance that names none leaves them to its own timeouts.
   */
  private reconcile(held: unknown): void {
    if (this.reconciled || !Array.isArray(held)) return;
    this.reconciled = true;
    const holds = this.options.holds;
    if (!holds) return;
    for (const raw of held) {
      const { id, state } = (raw ?? {}) as { id?: unknown; state?: unknown };
      if (!isRequestId(id) || this.claimed.has(id) || holds(id)) continue;
      const ended =
        state === 'claimed'
          ? this.answer(id, { decision: 'refused', detail: RESTARTED })
          : this.report(id, { state: 'ended', outcome: state === 'stopping' ? 'stopped' : 'error', detail: RESTARTED });
      void ended.catch(() => {});
    }
  }

  private offer(raw: unknown): void {
    const request = readOffer(raw);
    if (!request || this.offered.has(request.id) || this.claimed.has(request.id)) return;
    const expires = Date.parse(request.expiresAt);
    if (Number.isFinite(expires) && expires <= Date.now()) return;
    this.offered.set(request.id, Number.isFinite(expires) ? expires : Date.now() + 2 * 60_000);
    this.offeredAt.set(request.id, Date.now());
    this.options.onOffer(request);
  }

  private withdraw(id: string): void {
    this.offeredAt.delete(id);
    if (!this.offered.delete(id)) return;
    this.options.onWithdrawn(id);
  }

  private tellStop(id: string): void {
    if (this.stopsTold.has(id)) return;
    this.stopsTold.add(id);
    this.options.onStop(id);
  }

  /** Drop the offers past their time. */
  private expireOffers(): void {
    const now = Date.now();
    for (const [id, expires] of this.offered) if (expires <= now) this.withdraw(id);
  }

  private schedulePoll(delay: number): void {
    if (this.stopped) return;
    if (this.poll) clearTimeout(this.poll);
    this.poll = setTimeout(() => void this.listRequests(), delay);
    this.poll.unref?.();
  }

  private async listRequests(): Promise<void> {
    if (this.stopped) return;
    const asked = ++this.listing;
    const askedAt = Date.now();
    try {
      const listed = await this.call<{ requests?: unknown; stops?: unknown; held?: unknown; projects?: unknown }>(
        'GET',
        '/api/run-targets/requests',
      );
      if (this.stopped || asked !== this.listing) return;
      this.takeNames(listed.projects);
      this.takeList(listed.requests, listed.stops, askedAt, listed.held);
      if (!this.streamOpen) this.setStatus('online');
    } catch (error) {
      if (this.stopped || asked !== this.listing) return;
      if (!this.streamOpen && !(error instanceof RequestHostError)) this.setStatus('offline');
    }
    this.expireOffers();
    this.schedulePoll(this.streamOpen ? this.timing.pollOpenMs : this.timing.pollClosedMs);
  }

  private openStream(): void {
    if (this.stopped) return;
    const controller = new AbortController();
    this.stream = controller;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), this.timing.idleMs);
      idle.unref?.();
    };
    const run = async (): Promise<{ status: number; message: string } | null> => {
      const response = await this.fetch(`${this.options.instance}/api/run-targets/stream`, {
        headers: { Authorization: `Bearer ${this.options.key}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        return {
          status: response.status,
          message: isRevokedStatus(response.status) ? await refusalMessage(response) : '',
        };
      }
      this.streamOpen = true;
      this.failures = 0;
      this.setStatus('online');
      // Listed once now, so the app is seen at once, then every minute while the stream stays open.
      this.schedulePoll(0);
      touch();
      await readEventStream(
        response.body,
        (data) => {
          try {
            this.take(JSON.parse(data) as StreamEvent);
          } catch {
            // An event this host cannot read is left out.
          }
        },
        touch,
      );
      return null;
    };
    run()
      .then(
        (refused) => {
          if (refused !== null && isRevokedStatus(refused.status)) {
            this.revoked(refused.message || undefined, refused.status === 401 && refused.message !== '');
          }
          return refused?.status ?? null;
        },
        () => null,
      )
      .then((refused) => {
        if (idle) clearTimeout(idle);
        const wasOpen = this.streamOpen;
        this.streamOpen = false;
        if (this.stopped) return;
        if (!wasOpen) this.failures++;
        this.setStatus('offline');
        // Too many streams open (429): the others of this app hold the requests, so wait the longest.
        const wait =
          refused === 429
            ? this.timing.retryLastMs
            : Math.min(this.timing.retryFirstMs * 2 ** Math.max(0, this.failures - 1), this.timing.retryLastMs);
        this.retry = setTimeout(() => this.openStream(), wait);
        this.retry.unref?.();
        this.schedulePoll(this.timing.pollClosedMs);
      });
  }
}
