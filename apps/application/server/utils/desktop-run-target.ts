/**
 * Desktop build: the desktop app as a run target of one team instance (**Run on my machine**). The bundled server
 * runs the request host (`@piwitests/editor/request-host`) with the key the shell keeps in the OS keychain, claims
 * each request offered, checks it against the folder linked to its project on this machine and asks the person in the
 * window. After **Run**, the shell takes the request token and the command from here (`launchOf`), starts the run and
 * reports it started and ended; a stop from the dashboard goes to the shell on its notification stream.
 *
 * Nothing is stored: the key and the folders come from the shell after each start (`useKeptKey`), the requests live
 * in memory while they are asked about or run. The window never reads the key nor a request token.
 */
import os from 'node:os';
import type { RunRequest, RunRequestOffer, RunRequestOutcome } from '@piwitests/core/run-request';
import { RUN_REQUEST_ID } from '@piwitests/core/run-request';
import { RequestHost, RequestHostError, type RequestHostStatus } from '@piwitests/editor/request-host';
import { planRequestedRun, type RequestPlan } from '@piwitests/editor/request-run';
import type { RunRequestPromptView, RunTargetConnectionView, RunTargetMessage } from '#shared/desktop-run-target';
import { REQUEST_TOKEN_LIFETIME_MS } from './request-tokens';

/** How long a claimed request waits for the person's answer, as the instance counts it. */
const ANSWER_WITHIN_MS = 10 * 60 * 1000;

/** A request the app claimed: asked about, then run. */
interface HeldRequest {
  request: RunRequest;
  plan: RequestPlan;
  answerBy: number;
  /** After **Run**: the request token, until the shell takes it, and whether the run started. */
  token: string | null;
  launched: boolean;
  /** Whether the requester asked to stop it. */
  stopRequested: boolean;
  /** Whether **Run** is being answered to the instance now. */
  answering: boolean;
  /** Drops the request once nobody answered it, or once its token was never taken. */
  expiry: ReturnType<typeof setTimeout> | null;
}

/** What the shell hears on its notification stream: stop the run a request started. */
export interface ShellRunTargetCommand {
  type: 'requested-run-stop';
  requestId: string;
}

interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: number;
}

const state: {
  instance: string | null;
  key: string | null;
  keyToKeep: boolean;
  status: RequestHostStatus | 'none' | 'signing-in';
  error: string | null;
  flow: DeviceFlow | null;
  flowTimer: ReturnType<typeof setTimeout> | null;
  host: RequestHost | null;
  links: Map<number, string>;
  held: Map<string, HeldRequest>;
  /** The requests being claimed and checked, and the stops heard for them meanwhile. */
  claiming: Set<string>;
  stoppedWhileClaiming: Set<string>;
} = {
  instance: null,
  key: null,
  keyToKeep: false,
  status: 'none',
  error: null,
  flow: null,
  flowTimer: null,
  host: null,
  links: new Map(),
  held: new Map(),
  claiming: new Set(),
  stoppedWhileClaiming: new Set(),
};

const windowListeners = new Set<(message: RunTargetMessage) => void>();
const shellListeners = new Set<(command: ShellRunTargetCommand) => void>();

/** Hear what the window shows; the listener is told the connection at once. */
export function subscribeRunTargetWindow(listener: (message: RunTargetMessage) => void): () => void {
  windowListeners.add(listener);
  return () => windowListeners.delete(listener);
}

/** Hear what the shell must do. */
export function subscribeRunTargetShell(listener: (command: ShellRunTargetCommand) => void): () => void {
  shellListeners.add(listener);
  return () => shellListeners.delete(listener);
}

function tellWindow(message: RunTargetMessage): void {
  for (const listener of windowListeners) listener(message);
}

function tellShell(command: ShellRunTargetCommand): void {
  for (const listener of shellListeners) listener(command);
}

/** The connection, as the window shows it. */
export function runTargetConnection(): RunTargetConnectionView {
  return {
    state: state.status === 'signing-in' ? 'signing-in' : state.status,
    instance: state.instance,
    userCode: state.status === 'signing-in' ? (state.flow?.userCode ?? null) : null,
    verificationUrl: state.status === 'signing-in' ? (state.flow?.verificationUrl ?? null) : null,
    error: state.error,
    keyToKeep: state.keyToKeep,
    linkedProjectIds: [...state.links.keys()].sort((a, b) => a - b),
  };
}

function tellConnection(): void {
  tellWindow({ type: 'run-target', connection: runTargetConnection() });
}

/** The requests the window still asks about, for a window that opens later. */
export function waitingRunRequests(): RunRequestPromptView[] {
  return [...state.held.values()].filter((held) => !held.token && !held.launched).map(promptOf);
}

function promptOf(held: HeldRequest): RunRequestPromptView {
  const { request, plan } = held;
  return {
    id: request.id,
    instance: state.instance ?? '',
    projectId: request.projectId,
    tests: request.tests,
    options: request.options,
    source: request.source,
    checks: plan.checks,
    runnable: plan.runnable,
    command: plan.display,
    hasFolder: state.links.has(request.projectId),
    answerBy: new Date(held.answerBy).toISOString(),
  };
}

/** An instance URL the app may connect to: http(s), with no credentials, query or fragment, without a trailing `/`. */
export function instanceUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The folders the shell links, keyed by the instance's project ids. */
export function linksOf(value: unknown): Map<number, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const links = new Map<number, string>();
  for (const [id, folder] of Object.entries(value as Record<string, unknown>)) {
    const projectId = Number(id);
    if (!Number.isInteger(projectId) || projectId < 1 || typeof folder !== 'string' || !folder || folder.length > 4096)
      return null;
    links.set(projectId, folder);
  }
  return links.size <= 200 ? links : null;
}

function desktopVersion(): string {
  try {
    return (useRuntimeConfig().public as { appVersion?: string }).appVersion || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function platformName(): string {
  return { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform as string] ?? process.platform;
}

/** Stop the host and forget every request it held. */
function stopHost(): void {
  state.host?.close();
  state.host = null;
  for (const [id, held] of state.held) {
    if (held.expiry) clearTimeout(held.expiry);
    tellWindow({ type: 'run-request-gone', id, reason: 'stopped' });
  }
  state.held.clear();
  state.claiming.clear();
  state.stoppedWhileClaiming.clear();
}

/** Forget a held request: its timer goes, and the window stops asking about it. */
function drop(id: string, reason: 'answered' | 'expired' | 'stopped'): void {
  const held = state.held.get(id);
  if (!held) return;
  if (held.expiry) clearTimeout(held.expiry);
  state.held.delete(id);
  tellWindow({ type: 'run-request-gone', id, reason });
}

/** Drop a held request `afterMs` from now unless its run started by then. */
function expireLater(id: string, held: HeldRequest, afterMs: number): void {
  if (held.expiry) clearTimeout(held.expiry);
  held.expiry = setTimeout(() => {
    if (state.held.get(id) === held && !held.launched && !held.answering) drop(id, 'expired');
  }, afterMs);
  held.expiry.unref?.();
}

function startHost(instance: string, key: string): void {
  stopHost();
  state.instance = instance;
  state.key = key;
  state.error = null;
  state.status = 'connecting';
  const host = new RequestHost({
    instance,
    key,
    describe: () => ({ platform: platformName(), version: desktopVersion(), projectIds: [...state.links.keys()] }),
    onOffer: (offer) => void takeOffer(host, offer),
    onWithdrawn: () => {},
    onStop: (id) => void takeStop(host, id),
    onStatus: (status, detail) => {
      state.status = status;
      if (status === 'revoked') {
        state.error = detail || 'The instance disconnected this app.';
        state.key = null;
        stopHost();
      }
      tellConnection();
    },
  });
  state.host = host;
  host.start();
  tellConnection();
}

async function takeOffer(host: RequestHost, offer: RunRequestOffer): Promise<void> {
  if (state.host !== host || state.held.has(offer.id) || state.claiming.has(offer.id)) return;
  state.claiming.add(offer.id);
  try {
    let request: RunRequest;
    try {
      request = await host.claim(offer.id);
    } catch {
      // Another of the person's apps claimed it, or it no longer waits.
      return;
    }
    if (state.host !== host) return;
    let plan: RequestPlan;
    try {
      plan = await planRequestedRun(request, state.links.get(request.projectId) ?? null);
    } catch (error) {
      await host
        .answer(request.id, {
          decision: 'refused',
          detail: `This app could not check the request: ${errorText(error)}`,
        })
        .catch(() => {});
      return;
    }
    // Stopped from the dashboard while it was claimed and checked: the instance ended it already.
    if (state.host !== host || state.stoppedWhileClaiming.has(request.id)) return;
    const held: HeldRequest = {
      request,
      plan,
      answerBy: Date.now() + ANSWER_WITHIN_MS,
      token: null,
      launched: false,
      stopRequested: false,
      answering: false,
      expiry: null,
    };
    state.held.set(request.id, held);
    expireLater(request.id, held, ANSWER_WITHIN_MS);
    tellWindow({ type: 'run-request', request: promptOf(held) });
  } finally {
    state.claiming.delete(offer.id);
    state.stoppedWhileClaiming.delete(offer.id);
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function takeStop(host: RequestHost, id: string): Promise<void> {
  if (state.host !== host) return;
  if (state.claiming.has(id)) {
    state.stoppedWhileClaiming.add(id);
    return;
  }
  const held = state.held.get(id);
  if (!held) return;
  held.stopRequested = true;
  if (held.launched) {
    tellShell({ type: 'requested-run-stop', requestId: id });
    await host.report(id, { state: 'stopping', detail: 'Stopped from the dashboard' }).catch(() => {});
    return;
  }
  // **Run** is being answered: the answer ends it once it returns.
  if (held.answering) return;
  // Answered but not started: nothing runs, so it ends here as stopped.
  if (held.token) await host.report(id, { state: 'ended', outcome: 'stopped' }).catch(() => {});
  // Not answered: the instance ended it as stopped, so the window stops asking.
  drop(id, 'stopped');
}

/** Use the key the shell kept, with the folders it links: after each start, and when they change. */
export function useKeptKey(instance: string, key: string, links: Map<number, string>): void {
  state.links = links;
  state.keyToKeep = false;
  if (state.instance === instance && state.key === key && state.host) {
    void state.host.describe().catch(() => {});
    tellConnection();
    return;
  }
  startHost(instance, key);
}

/** The folders the shell links changed. */
export function useLinks(links: Map<number, string>): void {
  state.links = links;
  void state.host?.describe().catch(() => {});
  tellConnection();
}

/** The key the device flow gave, for the shell to keep in the keychain; null once kept or with none. */
export function keyToKeep(): { instance: string; key: string } | null {
  return state.keyToKeep && state.instance && state.key ? { instance: state.instance, key: state.key } : null;
}

/** Disconnect from the instance: the shell forgets the key. Its key stays listed in Connected apps until revoked. */
export function disconnectRunTarget(): void {
  if (state.flowTimer) clearTimeout(state.flowTimer);
  state.flowTimer = null;
  state.flow = null;
  stopHost();
  state.instance = null;
  state.key = null;
  state.keyToKeep = false;
  state.error = null;
  state.status = 'none';
  tellConnection();
}

async function postJson(url: string, body: unknown): Promise<{ status: number; answer: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, answer };
}

/**
 * Connect to `instance`: start the device flow there, for the person to allow the app on its page. Connecting to
 * another instance disconnects the first. Answers the code and the page to open.
 */
export async function connectRunTarget(instance: string): Promise<RunTargetConnectionView> {
  disconnectRunTarget();
  state.instance = instance;
  let started: Awaited<ReturnType<typeof postJson>>;
  try {
    started = await postJson(`${instance}/api/extension/connect`, {
      target: 'desktop',
      device: os.hostname().slice(0, 100) || 'this computer',
      os: platformName(),
    });
  } catch {
    state.error = 'The instance did not answer.';
    tellConnection();
    return runTargetConnection();
  }
  const { answer } = started;
  if (
    started.status !== 200 ||
    typeof answer.deviceCode !== 'string' ||
    typeof answer.userCode !== 'string' ||
    typeof answer.verificationUrl !== 'string'
  ) {
    state.error =
      typeof answer.message === 'string' ? answer.message : `The instance answered ${started.status} to connect.`;
    tellConnection();
    return runTargetConnection();
  }
  const interval = Math.min(Math.max(Number(answer.interval) || 5, 1), 60);
  state.flow = {
    deviceCode: answer.deviceCode,
    userCode: answer.userCode,
    verificationUrl: answer.verificationUrl,
    interval,
    expiresAt: Date.now() + Math.min(Number(answer.expiresIn) || 600, 900) * 1000,
  };
  state.status = 'signing-in';
  pollFlow(instance, state.flow);
  tellConnection();
  return runTargetConnection();
}

function pollFlow(instance: string, flow: DeviceFlow): void {
  state.flowTimer = setTimeout(async () => {
    if (state.flow !== flow) return;
    if (Date.now() > flow.expiresAt) {
      state.flow = null;
      state.status = 'none';
      state.error = 'The sign-in on the instance expired: connect again.';
      tellConnection();
      return;
    }
    let polled: Awaited<ReturnType<typeof postJson>> | null = null;
    try {
      polled = await postJson(`${instance}/api/extension/connect/token`, { deviceCode: flow.deviceCode });
    } catch {
      polled = null;
    }
    if (state.flow !== flow) return;
    const status = polled?.answer.status;
    if (status === 'approved' && typeof polled?.answer.apiKey === 'string' && polled.answer.apiKey) {
      state.flow = null;
      state.keyToKeep = true;
      startHost(instance, polled.answer.apiKey);
      return;
    }
    if (status === 'denied' || status === 'expired') {
      state.flow = null;
      state.status = 'none';
      state.error = status === 'denied' ? 'The connection was denied on the instance.' : 'The sign-in expired.';
      tellConnection();
      return;
    }
    if (status === 'slow_down') flow.interval = Math.min(flow.interval + 5, 60);
    pollFlow(instance, flow);
  }, flow.interval * 1000);
  state.flowTimer.unref?.();
}

/** Check a held request again, after the person linked its folder. */
export async function planAgain(id: string): Promise<RunRequestPromptView | null> {
  const held = state.held.get(id);
  if (!held || held.token || held.launched) return null;
  held.plan = await planRequestedRun(held.request, state.links.get(held.request.projectId) ?? null);
  return promptOf(held);
}

/** Whether a value is a request id, as the routes take it. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && RUN_REQUEST_ID.test(value);
}

/**
 * The person's answer in the window. **Run** on a request whose checks pass takes the request token, for the shell;
 * **Not now** declines it, or refuses it with the checks that failed.
 */
export async function answerRunRequest(
  id: string,
  decision: 'run' | 'not-now',
  shownCommand: string | null = null,
): Promise<{ ok: true; launch: boolean } | { ok: false; statusCode: number; message: string }> {
  const held = state.held.get(id);
  const host = state.host;
  if (!held || !host || held.token || held.launched || held.answering) {
    return { ok: false, statusCode: 404, message: 'This request is no longer asked about' };
  }
  held.answering = true;
  try {
    if (decision === 'run') {
      held.plan = await planRequestedRun(held.request, state.links.get(held.request.projectId) ?? null);
      // The folder changed since the window showed it: it shows the checks and the command again.
      if (!held.plan.runnable || held.plan.display !== shownCommand) {
        tellWindow({ type: 'run-request', request: promptOf(held) });
        return {
          ok: false,
          statusCode: 409,
          message: held.plan.runnable
            ? 'The folder changed since: check the command again'
            : 'A check failed: the run cannot start',
        };
      }
      const { requestToken } = await host.answer(id, { decision: 'run' });
      if (!requestToken) throw new RequestHostError(502, 'The instance gave no request token');
      if (state.held.get(id) !== held || held.stopRequested) {
        await host.report(id, { state: 'ended', outcome: 'stopped' }).catch(() => {});
        drop(id, 'stopped');
        return { ok: true, launch: false };
      }
      held.token = requestToken;
      // A token the window never hands the shell (the window closed) is dropped once it can start nothing.
      expireLater(id, held, REQUEST_TOKEN_LIFETIME_MS);
      tellWindow({ type: 'run-request-gone', id, reason: 'answered' });
      return { ok: true, launch: true };
    }
    const failed = held.plan.checks.filter((c) => c.level === 'fail').map((c) => c.message);
    await host.answer(
      id,
      failed.length > 0 ? { decision: 'refused', detail: failed.join(' ').slice(0, 500) } : { decision: 'not-now' },
    );
  } catch (error) {
    drop(id, 'expired');
    const status = error instanceof RequestHostError ? error.status : 502;
    return { ok: false, statusCode: status === 409 ? 409 : 502, message: (error as Error).message };
  } finally {
    held.answering = false;
  }
  drop(id, 'answered');
  return { ok: true, launch: false };
}

/**
 * What the shell starts for a request after **Run**: the instance and the request token, once, the project its
 * folder is linked for, and the arguments after `playwright test`. Null for any other request.
 */
export function launchOf(id: string): { instance: string; token: string; projectId: number; args: string[] } | null {
  const held = state.held.get(id);
  if (!held?.token || held.launched || !state.instance) return null;
  const token = held.token;
  held.token = null;
  held.launched = true;
  if (held.expiry) clearTimeout(held.expiry);
  held.expiry = null;
  return { instance: state.instance, token, projectId: held.request.projectId, args: held.plan.args };
}

/** The shell started the run of a request. */
export async function requestedRunStarted(id: string): Promise<void> {
  const held = state.held.get(id);
  if (!held?.launched || !state.host) return;
  await state.host.report(id, { state: 'running' }).catch(() => {});
}

/** Playwright's exit code after an interrupt: the window's Stop, or Ctrl+C. */
const INTERRUPTED = 130;

/** The outcome of a requested run from how its Playwright process exited, and whether a stop was asked for it. */
export function outcomeOf(code: number | null, stopRequested: boolean): RunRequestOutcome {
  if (stopRequested || code === INTERRUPTED) return 'stopped';
  if (code === 0) return 'passed';
  if (code === 1) return 'failed';
  return 'error';
}

/**
 * The shell's run of a request ended with `code` (null when it was killed); `stopped` when a stop was asked for it,
 * from the dashboard or the window.
 */
export async function requestedRunEnded(id: string, code: number | null, stopped = false): Promise<void> {
  const held = state.held.get(id);
  if (!held?.launched) return;
  state.held.delete(id);
  const outcome = outcomeOf(code, held.stopRequested || stopped);
  const detail = outcome === 'error' ? `Playwright exited with ${code ?? 'no code'}` : undefined;
  await state.host?.report(id, { state: 'ended', outcome, ...(detail ? { detail } : {}) }).catch(() => {});
}

/** The run of a request the shell could not start. */
export async function requestedRunFailed(id: string, detail: string): Promise<void> {
  const held = state.held.get(id);
  if (!held) return;
  if (held.expiry) clearTimeout(held.expiry);
  state.held.delete(id);
  await state.host?.report(id, { state: 'ended', outcome: 'error', detail: detail.slice(0, 500) }).catch(() => {});
}

/** For tests: forget everything. */
export function resetDesktopRunTarget(): void {
  disconnectRunTarget();
  state.links = new Map();
  windowListeners.clear();
  shellListeners.clear();
}
