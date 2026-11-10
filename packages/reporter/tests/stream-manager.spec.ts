import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { StreamManager } from '../src/internal/streaming/stream-manager.js';
import { StreamBuffer } from '../src/internal/streaming/stream-buffer.js';
import { CrashRecovery, recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import { privateTempDir } from '../src/internal/support/private-file.js';
import { FileHandler } from '../src/internal/files/file-handler.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import { DesktopNotProvenError, HttpClient, HttpError } from '../src/internal/transport/http-client.js';
import { getSetupFilePath, writeSetupInfo } from '../src/internal/support/setup-file.js';
import { Logger } from '../src/internal/support/logger.js';
import { desktopTokenProof } from '@piwitests/core/desktop-proof';
import type { PiwiDashboardOptions } from '../src/public/options.js';
import type { CompleteStreamEvent, StepBeginStreamEvent, StepEndStreamEvent } from '../src/types/wire.js';

const projectName = 'piwi-stream-test-' + process.pid;
const projectHash = hashForProject(projectName);
const RECOVERY_SERVER = 'http://localhost:3000';

/** The error Node raises for a connection the instance refused: the request reached no instance. */
function refusedConnection(): Error {
  return Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
}

function cleanup(): void {
  const tmp = privateTempDir();
  for (const f of fs.readdirSync(tmp)) {
    if (f.startsWith(`piwi-dashboard-stream-${projectHash}`)) {
      try {
        fs.unlinkSync(path.join(tmp, f));
      } catch {
        /* ignore */
      }
    }
  }
  fs.rmSync(recoveryFilePath(RECOVERY_SERVER, projectName), { force: true });
}

function makeOptions(overrides: Partial<PiwiDashboardOptions> = {}): PiwiDashboardOptions {
  return {
    serverUrl: 'http://localhost:3000',
    projectName,
    streaming: true,
    streamingBatchSize: 3,
    streamingBatchDelay: 1000,
    uploadTraces: false,
    liveFileUploads: false,
    verbose: false,
    ...overrides,
  } as PiwiDashboardOptions;
}

function completeEvent(title: string): CompleteStreamEvent {
  return {
    type: 'complete',
    title,
    location: 'test.spec.ts:1:1',
    status: 'passed',
    duration: 0,
    error: null,
    retries: 0,
    workerIndex: 0,
    shardIndex: null,
    startedAt: null,
  };
}

function stepBeginEvent(title: string): StepBeginStreamEvent {
  return {
    type: 'step-begin',
    title,
    location: 'test.spec.ts:2:3',
    stepCategory: 'pw:api',
    parentTitle: 'the test',
    workerIndex: 0,
    shardIndex: null,
    startedAt: null,
  };
}

function stepEndEvent(title: string): StepEndStreamEvent {
  return { ...stepBeginEvent(title), type: 'step-end', status: 'passed', duration: 1 };
}

describe('StreamManager batching & drain', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('flushes immediately when batchSize is reached', async () => {
    const calls: string[] = [];
    const http = {
      async postJSON(url: string) {
        calls.push(url);
        return {};
      },
      async resolveAuth() {
        return null;
      },
    };
    const options = makeOptions({ streamingBatchSize: 3, streamingBatchDelay: 60000 });
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      options,
    );
    // Force enabled state without going through the async handshake.
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';

    sm.queueEvent(completeEvent('a'));
    sm.queueEvent(completeEvent('b'));
    expect(calls.length, 'no flush before batchSize').toBe(0);
    sm.queueEvent(completeEvent('c'));
    expect(calls.length, 'flush at batchSize').toBe(1);
    // wait for the in-flight flush to settle
    await sm.drain();
    expect(calls.length).toBe(1);
  });

  it('drain flushes pending events', async () => {
    const calls: string[] = [];
    const http = {
      async postJSON(url: string) {
        calls.push(url);
        return {};
      },
      async resolveAuth() {
        return null;
      },
    };
    const options = makeOptions({ streamingBatchSize: 100, streamingBatchDelay: 60000 });
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      options,
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';

    sm.queueEvent(completeEvent('a'));
    sm.queueEvent(completeEvent('b'));
    // batchSize not reached and no timer fired yet → drain must flush
    await sm.drain();
    expect(calls.length).toBe(1);
  });

  it('re-queues events on flush failure so drain can retry', async () => {
    let attempts = 0;
    const http = {
      async postJSON() {
        attempts++;
        if (attempts < 2) throw new Error('Request failed with status 500');
        return {};
      },
      async resolveAuth() {
        return null;
      },
    };
    const options = makeOptions({ streamingBatchSize: 100, streamingBatchDelay: 60000 });
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      options,
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';

    sm.queueEvent(completeEvent('a'));
    await sm.drain();
    expect(attempts, `expected at least 2 attempts, got ${attempts}`).toBeGreaterThanOrEqual(2);
  });

  it('drain is a no-op when streaming is disabled', async () => {
    const calls: string[] = [];
    const http = {
      async postJSON(url: string) {
        calls.push(url);
        return {};
      },
      async resolveAuth() {
        return null;
      },
    };
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions(),
    );
    (sm as any)._enabled = false;
    (sm as any).pendingEvents.enqueue(completeEvent('x'));
    await sm.drain();
    expect(calls.length).toBe(0);
  });

  it('persisted buffer events are replayed on retry', async () => {
    // Simulate a crash: events were persisted to the StreamBuffer file.
    // On the next drain, after a failed flush + retry, the buffered events
    // should be loaded back and re-sent.
    const buffer = new StreamBuffer(projectName);
    buffer.bindRun(1);
    buffer.append([completeEvent('buffered-1')]);

    let seen: any[] = [];
    let attempt = 0;
    const http = {
      async postJSON(_url: string, body: any) {
        attempt++;
        if (attempt === 1) {
          // first flush fails → scheduleRetry loads the buffer back
          throw new Error('Request failed with status 500');
        }
        seen = body.testCases;
        return {};
      },
      async resolveAuth() {
        return null;
      },
    };
    const options = makeOptions({ streamingBatchSize: 100, streamingBatchDelay: 60000 });
    const sm = new StreamManager(
      http as any,
      buffer,
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      options,
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';

    sm.queueEvent(completeEvent('queued-1'));
    await sm.drain();
    // After retry, the buffered event should be among those sent.
    expect(
      seen.some((e: any) => e.title === 'buffered-1'),
      `seen: ${JSON.stringify(seen)}`,
    ).toBeTruthy();
  });
});

describe('StreamManager run-scoped buffer', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("never replays another run's buffered events into the run it opened", async () => {
    // Leftovers of run 1, as a drain that gave up would leave them.
    const previous = new StreamBuffer(projectName);
    previous.bindRun(1);
    previous.append([completeEvent('run-1-leftover')]);

    const sent: string[] = [];
    const http = {
      async postJSON(url: string, body: any) {
        if (url === '/api/test-runs/start') return { runId: 2, streamToken: 'tok-2' };
        if (url === '/api/test-runs/2/events') sent.push(...body.testCases.map((e: any) => e.title));
        return {};
      },
      async resolveAuth() {
        return null;
      },
    };
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions({ streamingBatchSize: 100, streamingBatchDelay: 60000 }),
    );
    sm.start(new Date().toISOString(), {}, 'instance');
    await sm.startPromise;
    expect(sm.runId).toBe(2);

    sm.queueEvent(completeEvent('run-2-event'));
    await sm.drain();

    expect(sent).toEqual(['run-2-event']);
    expect(previous.load().map((e) => e.title)).toEqual(['run-1-leftover']);
  });

  it('holds nothing and writes nothing until a run is bound', () => {
    const buffer = new StreamBuffer(projectName);
    buffer.append([completeEvent('unbound')]);
    expect(buffer.load()).toEqual([]);
    expect(fs.readdirSync(privateTempDir()).some((f) => f.startsWith(`piwi-dashboard-stream-${projectHash}`))).toBe(
      false,
    );
  });

  it("discardBuffered deletes the run's buffer file", () => {
    const buffer = new StreamBuffer(projectName);
    buffer.bindRun(7);
    buffer.append([completeEvent('leftover')]);
    const sm = new StreamManager(
      {} as any,
      buffer,
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions(),
    );
    sm.discardBuffered();
    expect(buffer.load()).toEqual([]);
  });

  it("clearStale removes the project's stale buffer files of every run and keeps fresh ones", () => {
    const stale = new StreamBuffer(projectName);
    stale.bindRun(1);
    stale.append([completeEvent('stale')]);
    const fresh = new StreamBuffer(projectName);
    fresh.bindRun(2);
    fresh.append([completeEvent('fresh')]);
    const staleFile = path.join(privateTempDir(), `piwi-dashboard-stream-${projectHash}-1.jsonl`);
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, threeHoursAgo, threeHoursAgo);

    new StreamBuffer(projectName).clearStale();

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fresh.load().map((e) => e.title)).toEqual(['fresh']);
  });
});

describe('StreamManager idle heartbeat', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  function makeEnabledManager(postJSON: (url: string, body: any) => Promise<any>): StreamManager {
    const http = {
      postJSON,
      async resolveAuth() {
        return null;
      },
    };
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions(),
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';
    (sm as any).heartbeatInterval = 20;
    return sm;
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('pings the heartbeat endpoint after an idle gap', async () => {
    const calls: string[] = [];
    const sm = makeEnabledManager(async (url) => {
      calls.push(url);
      return {};
    });
    (sm as any).lastActivityAt = Date.now() - 1000; // already idle
    (sm as any).scheduleHeartbeat();
    await wait(70);
    (sm as any).stopHeartbeat();
    expect(calls.some((u) => u.includes('/heartbeat'))).toBe(true);
  });

  it('skips the heartbeat when activity arrives before it fires', async () => {
    const calls: string[] = [];
    const sm = makeEnabledManager(async (url) => {
      calls.push(url);
      return {};
    });
    (sm as any).heartbeatInterval = 30;
    (sm as any).lastActivityAt = Date.now();
    (sm as any).scheduleHeartbeat();
    // Activity lands before the timer fires → idle gap resets, ping is redundant.
    setTimeout(() => {
      (sm as any).lastActivityAt = Date.now();
    }, 20);
    await wait(45);
    (sm as any).stopHeartbeat();
    expect(calls.length).toBe(0);
  });

  it('takes a heartbeat refused with 409 as the run ended, and sends no more', async () => {
    const calls: string[] = [];
    const sm = makeEnabledManager(async (url) => {
      calls.push(url);
      throw new HttpError(409);
    });
    (sm as any).lastActivityAt = Date.now() - 1000;
    (sm as any).scheduleHeartbeat();
    await wait(100);
    sm.queueEvent(completeEvent('after'));
    await sm.drain();

    expect(calls).toEqual(['/api/test-runs/1/heartbeat']);
    expect(sm.runEnded).toBe(true);
  });

  it('drain stops the heartbeat', async () => {
    const calls: string[] = [];
    const sm = makeEnabledManager(async (url) => {
      calls.push(url);
      return {};
    });
    (sm as any).lastActivityAt = Date.now() - 1000;
    (sm as any).scheduleHeartbeat();
    await sm.drain();
    const afterDrain = calls.length;
    await wait(70);
    expect(calls.length, 'no heartbeats fire after drain').toBe(afterDrain);
  });
});

describe('StreamManager live steps', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  // An open stream whose requests are recorded and answered by `answer`.
  function makeEnabledManager(answer: (url: string) => unknown) {
    const requests: Array<{ url: string; body: any }> = [];
    const http = {
      async postJSON(url: string, body: any) {
        requests.push({ url, body });
        return answer(url);
      },
      async resolveAuth() {
        return null;
      },
    };
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions({ streamingBatchSize: 1_000_000, streamingBatchDelay: 3_600_000 }),
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';
    return { sm, requests };
  }

  // The events that reached `/events`, in order, as `type title`.
  const sent = (requests: Array<{ url: string; body: any }>) =>
    requests
      .filter((r) => r.url.endsWith('/events'))
      .flatMap((r) => r.body.testCases.map((e: { type: string; title: string }) => `${e.type} ${e.title}`));

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('drops step events while the dashboard says nobody watches the run', async () => {
    const { sm, requests } = makeEnabledManager(() => ({ success: true, watched: false }));
    sm.queueEvent(stepEndEvent('before the answer'));
    sm.queueEvent(completeEvent('a'));
    await sm.flush();
    sm.queueEvent(stepBeginEvent('unwatched'));
    sm.queueEvent(stepEndEvent('unwatched'));
    sm.queueEvent(completeEvent('b'));
    await sm.drain();
    expect(sent(requests)).toEqual(['step-end before the answer', 'complete a', 'complete b']);
  });

  it('sends step events again once the dashboard says someone watches', async () => {
    const answers = [{ watched: false }, { watched: true }];
    const { sm, requests } = makeEnabledManager(() => answers.shift() ?? { watched: true });
    sm.queueEvent(completeEvent('a'));
    await sm.flush();
    sm.queueEvent(stepEndEvent('unwatched'));
    sm.queueEvent(completeEvent('b'));
    await sm.flush();
    sm.queueEvent(stepEndEvent('watched'));
    await sm.drain();
    expect(sent(requests)).toEqual(['complete a', 'complete b', 'step-end watched']);
  });

  it('says once when someone opens the run, so the live resources go out at once', async () => {
    const answers = [{ watched: false }, { watched: true }, { watched: true }];
    const { sm } = makeEnabledManager(() => answers.shift() ?? { watched: true });
    const opened = vi.fn();
    sm.onWatched = opened;
    for (const title of ['a', 'b', 'c']) {
      sm.queueEvent(completeEvent(title));
      await sm.flush();
    }
    expect(opened).toHaveBeenCalledTimes(1);
    expect(sm.isWatched).toBe(true);
  });

  it('keeps sending step events to a dashboard that does not say', async () => {
    const { sm, requests } = makeEnabledManager(() => ({ success: true }));
    sm.queueEvent(completeEvent('a'));
    await sm.flush();
    sm.queueEvent(stepEndEvent('s'));
    await sm.drain();
    expect(sent(requests)).toEqual(['complete a', 'step-end s']);
  });

  it('brings its first heartbeat forward once the dashboard first says nobody watches', async () => {
    vi.useFakeTimers();
    try {
      const { sm, requests } = makeEnabledManager(() => ({ success: true, watched: false }));
      // The stream just opened: whether anyone watches is not known, so the first heartbeat is a watched run's.
      (sm as any).heartbeatInterval = 15_000;
      (sm as any).unwatchedHeartbeatInterval = 5_000;
      (sm as any).lastActivityAt = Date.now();
      (sm as any).scheduleHeartbeat();
      sm.queueEvent(completeEvent('a'));
      await sm.flush();
      expect((sm as any).watched).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requests.some((r) => r.url.endsWith('/heartbeat'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeats sooner while nobody watches, and a heartbeat answer turns the steps back on', async () => {
    const { sm, requests } = makeEnabledManager((url) => ({ success: true, watched: url.endsWith('/heartbeat') }));
    sm.queueEvent(completeEvent('a'));
    await sm.flush();
    // Only the unwatched interval is short enough for a heartbeat to fire here.
    (sm as any).heartbeatInterval = 60_000;
    (sm as any).unwatchedHeartbeatInterval = 20;
    (sm as any).lastActivityAt = Date.now() - 1000;
    (sm as any).scheduleHeartbeat();
    for (let i = 0; i < 100 && (sm as any).watched !== true; i++) await wait(10);
    expect(requests.some((r) => r.url.endsWith('/heartbeat'))).toBe(true);

    sm.queueEvent(stepEndEvent('watched'));
    await sm.drain();
    expect(sent(requests)).toEqual(['complete a', 'step-end watched']);
  });
});

describe('StreamManager buffer bounding', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  function makeManager(overrides: Partial<PiwiDashboardOptions>): StreamManager {
    const http = {
      async postJSON() {
        return {};
      },
      async resolveAuth() {
        return null;
      },
    };
    // Huge batch size + delay so nothing flushes mid-test: events pile up in the
    // in-memory queue, which is exactly where the byte bound must hold.
    const options = makeOptions({ streamingBatchSize: 1_000_000, streamingBatchDelay: 3_600_000, ...overrides });
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      options,
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';
    return sm;
  }

  function clearTimers(sm: StreamManager): void {
    const t = (sm as any).flushTimer;
    if (t) clearTimeout(t);
  }

  it('caps the in-memory buffer instead of growing without bound', () => {
    const sm = makeManager({ maxStreamBufferBytes: 50_000 });
    for (let i = 0; i < 5000; i++) {
      sm.queueEvent({ type: 'step-end', title: `s${i}`, pad: 'x'.repeat(100) } as any);
    }
    const q = (sm as any).pendingEvents;
    expect(q.bytes).toBeLessThanOrEqual(50_000);
    expect(q.droppedCount).toBeGreaterThan(0);
    expect(sm.lostResults).toBe(false); // only step events were shed
    clearTimers(sm);
  });

  it('flags lost results when result events must be shed to stay in budget', () => {
    const sm = makeManager({ maxStreamBufferBytes: 1_000 });
    for (let i = 0; i < 20; i++) {
      sm.queueEvent({ type: 'complete', title: `c${i}`, pad: 'x'.repeat(2000) } as any);
    }
    expect(sm.lostResults).toBe(true);
    const q = (sm as any).pendingEvents;
    expect(q.droppedByType.complete).toBeGreaterThan(0);
    clearTimers(sm);
  });

  it('drain never throws and clears the buffer even when over budget', async () => {
    const sm = makeManager({ maxStreamBufferBytes: 1_000, streamingBatchSize: 1_000_000 });
    for (let i = 0; i < 20; i++) {
      sm.queueEvent({ type: 'complete', title: `c${i}`, pad: 'x'.repeat(2000) } as any);
    }
    await expect(sm.drain()).resolves.toBeUndefined();
    expect((sm as any).pendingEvents.isEmpty).toBe(true);
  });
});

describe('StreamManager request sizing', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const SERVER_LIMIT = 10 * 1024 * 1024;

  function bigComplete(title: string, bytes: number): CompleteStreamEvent {
    return { ...completeEvent(title), error: 'x'.repeat(bytes) };
  }

  function makeManager(
    postJSON: (url: string, body: any, auth?: unknown, signal?: unknown, opts?: any) => Promise<any>,
    buffer = new StreamBuffer(projectName),
  ): StreamManager {
    const http = {
      postJSON,
      async resolveAuth() {
        return null;
      },
    };
    const sm = new StreamManager(
      http as any,
      buffer,
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions({ streamingBatchSize: 1_000_000, streamingBatchDelay: 3_600_000 }),
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';
    return sm;
  }

  it('splits a large backlog into requests under the server limit, in order', async () => {
    const bodySizes: number[] = [];
    const sent: string[] = [];
    const sm = makeManager(async (_url, body) => {
      bodySizes.push(Buffer.byteLength(JSON.stringify(body)));
      sent.push(...body.testCases.map((e: any) => e.title));
      return {};
    });
    const titles = Array.from({ length: 30 }, (_, i) => `t${i}`);
    for (const title of titles) sm.queueEvent(bigComplete(title, 500_000));

    await sm.drain();

    expect(sent).toEqual(titles);
    expect(bodySizes.length).toBeGreaterThan(1);
    for (const size of bodySizes) expect(size).toBeLessThan(SERVER_LIMIT);
    expect(sm.lostResults).toBe(false);
  });

  it('sends the stream token in the run token header beside the body', async () => {
    const sent: Array<{ body: any; headers: Record<string, string> | undefined }> = [];
    const sm = makeManager(async (_url, body, _auth?: unknown, _signal?: unknown, opts?: any) => {
      sent.push({ body, headers: opts?.headers });
      return {};
    });
    sm.queueEvent(completeEvent('a'));
    await sm.drain();
    expect(sent).toEqual([
      { body: expect.objectContaining({ streamToken: 'tok' }), headers: { 'X-Piwi-Run-Token': 'tok' } },
    ]);
  });

  it('splits a batch the server refuses as too large and still delivers every event', async () => {
    const sent: string[] = [];
    const sm = makeManager(async (_url, body) => {
      if (body.testCases.length > 2) throw new HttpError(413);
      sent.push(...body.testCases.map((e: any) => e.title));
      return {};
    });
    const titles = ['a', 'b', 'c', 'd', 'e'];
    for (const title of titles) sm.queueEvent(completeEvent(title));

    await sm.drain();

    expect(sent).toEqual(titles);
    expect(sm.lostResults).toBe(false);
  });

  it('drops a lone event the server refuses as too large, keeps streaming the rest, and flags the result as lost', async () => {
    let calls = 0;
    const sent: string[] = [];
    const sm = makeManager(async (_url, body) => {
      calls++;
      if (body.testCases.some((e: any) => e.title === 'huge')) throw new HttpError(413);
      sent.push(...body.testCases.map((e: any) => e.title));
      return {};
    });
    sm.queueEvent(completeEvent('a'));
    sm.queueEvent(completeEvent('huge'));
    sm.queueEvent(completeEvent('b'));

    await sm.drain();

    expect(sent).toEqual(['a', 'b']);
    expect(calls).toBeLessThan(10);
    expect(sm.lostResults).toBe(true);
  });

  it('never sends an event larger than the server limit', async () => {
    const sent: string[] = [];
    const sm = makeManager(async (_url, body) => {
      sent.push(...body.testCases.map((e: any) => e.title));
      return {};
    });
    sm.queueEvent(bigComplete('oversized', SERVER_LIMIT + 1));
    sm.queueEvent(completeEvent('after'));

    await sm.drain();

    expect(sent).toEqual(['after']);
    expect(sm.lostResults).toBe(true);
  });

  it('a dropped progress event does not flag lost results', async () => {
    const sm = makeManager(async () => ({}));
    sm.queueEvent({ type: 'step-end', title: 'step', pad: 'x'.repeat(SERVER_LIMIT + 1) } as any);
    await sm.drain();
    expect(sm.lostResults).toBe(false);
  });

  describe('when the drain gives up', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function drainAgainstDeadServer(events: any[]): Promise<{ sm: StreamManager; buffer: StreamBuffer }> {
      const buffer = new StreamBuffer(projectName);
      buffer.bindRun(1);
      const sm = makeManager(async () => {
        throw refusedConnection();
      }, buffer);
      for (const event of events) sm.queueEvent(event);
      const drained = sm.drain();
      await vi.runAllTimersAsync();
      await drained;
      return { sm, buffer };
    }

    it('flags undelivered results so the run is not finalized without them', async () => {
      const { sm } = await drainAgainstDeadServer([completeEvent('undelivered')]);
      expect(sm.lostResults).toBe(true);
    });

    it('writes the events still queued when it gives up to disk', async () => {
      const { buffer } = await drainAgainstDeadServer([
        { ...completeEvent('first'), error: 'x'.repeat(3_000_000) },
        { ...completeEvent('second'), error: 'x'.repeat(2_000_000) },
      ]);
      // The drain's tries take about a minute, under the grace before the oldest events are set aside.
      expect(buffer.load().map((e) => e.title)).toEqual(['first', 'second']);
    });

    it('does not flag lost results when only progress events are left', async () => {
      const { sm } = await drainAgainstDeadServer([{ type: 'step-end', title: 'step' }]);
      expect(sm.lostResults).toBe(false);
    });
  });
});

describe('StreamManager events the dashboard does not take', () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function makeManager(
    postJSON: (url: string, body: any) => Promise<any>,
    options: Partial<PiwiDashboardOptions> = {},
  ): StreamManager {
    const sm = new StreamManager(
      { postJSON, resolveAuth: async () => null } as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions({ streamingBatchSize: 1_000_000, streamingBatchDelay: 3_600_000, ...options }),
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';
    return sm;
  }

  async function drain(sm: StreamManager): Promise<void> {
    const drained = sm.drain();
    await vi.runAllTimersAsync();
    await drained;
  }

  it('sets aside a request refused with a client error at once, so the later events flow', async () => {
    const sent: string[] = [];
    let refusals = 0;
    const sm = makeManager(async (_url, body) => {
      if (body.testCases.some((e: any) => e.title === 'refused')) {
        refusals++;
        throw new HttpError(400);
      }
      sent.push(...body.testCases.map((e: any) => e.title));
      return {};
    });
    sm.queueEvent(completeEvent('refused'));
    await sm.flush();
    sm.queueEvent(completeEvent('later'));
    await drain(sm);

    expect(sent).toEqual(['later']);
    expect(refusals).toBe(1);
    // The refused result goes with the end-of-run batch upload, which carries the whole run.
    expect(sm.lostResults).toBe(true);
  });

  it('takes a 409 as the run ended: sends nothing more to it and leaves its results to the batch upload', async () => {
    const posts: string[] = [];
    const sm = makeManager(async (url, body) => {
      posts.push(`${url} ${body.testCases?.map((e: any) => e.title).join(',') ?? ''}`.trim());
      throw new HttpError(409);
    });
    sm.queueEvent(completeEvent('refused'));
    sm.queueEvent(completeEvent('with it'));
    await sm.flush();

    // A later result, a retry or the heartbeat would only be refused again.
    sm.queueEvent(completeEvent('later'));
    sm.queueEvent({ ...completeEvent('next'), type: 'begin' } as any);
    await vi.advanceTimersByTimeAsync(120_000);
    await drain(sm);

    expect(posts).toEqual(['/api/test-runs/1/events refused,with it']);
    expect(sm.runEnded).toBe(true);
    expect(sm.enabled).toBe(false);
    // Failures that come after link to the run the batch upload creates.
    expect(sm.runId).toBeNull();
  });

  it('sets nothing aside through an outage shorter than two and a half minutes, however many sends fail in it', async () => {
    const sent: string[] = [];
    let down = true;
    const sm = makeManager(
      async (_url, body) => {
        if (down) throw refusedConnection();
        sent.push(...body.testCases.map((e: any) => e.title));
        return {};
      },
      { streamingBatchSize: 1 },
    );
    // Three seconds down at twenty results a second: each result is sent at once, and fails.
    const titles = Array.from({ length: 60 }, (_, i) => `result ${i}`);
    for (const title of titles) {
      sm.queueEvent(completeEvent(title));
      await vi.advanceTimersByTimeAsync(50);
    }
    down = false;
    await drain(sm);

    expect(sent).toEqual(titles);
    expect(sm.lostResults).toBe(false);
  });

  it('sets aside a request still failing with a server error two and a half minutes after its first failure', async () => {
    const sent: string[] = [];
    let attempts = 0;
    const sm = makeManager(async (_url, body) => {
      if (body.testCases.some((e: any) => e.title === 'failing')) {
        attempts++;
        throw new HttpError(500);
      }
      sent.push(...body.testCases.map((e: any) => e.title));
      return {};
    });
    // Large enough to go in two requests.
    sm.queueEvent({ ...completeEvent('failing'), error: 'x'.repeat(3_000_000) });
    sm.queueEvent({ ...completeEvent('later'), error: 'x'.repeat(2_000_000) });
    void sm.flush();
    // The back-off retries it while the run goes on, the tenth at 151 s.
    await vi.advanceTimersByTimeAsync(149_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toEqual(['later']);
    expect(attempts).toBe(10);
    expect(sm.lostResults).toBe(true);
    await drain(sm);
  });

  it('sets aside progress that gets no answer for two and a half minutes without flagging results', async () => {
    let attempts = 0;
    const sm = makeManager(async () => {
      attempts++;
      throw refusedConnection();
    });
    sm.queueEvent({ type: 'step-end', title: 'step' } as any);
    void sm.flush();
    await vi.advanceTimersByTimeAsync(151_000);

    expect(attempts).toBe(10);
    expect(sm.lostResults).toBe(false);
    // Nothing is left to send.
    await drain(sm);
    expect(attempts).toBe(10);
  });
});

describe('StreamManager end-of-run bounds', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  function makeManager(http: Record<string, unknown>, uploader: Record<string, unknown> = {}): StreamManager {
    const client = {
      async resolveAuth() {
        return null;
      },
      ...http,
    };
    const sm = new StreamManager(
      client as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      uploader as any,
      new FileHandler(),
      makeOptions({ streamingBatchSize: 1_000_000, streamingBatchDelay: 3_600_000 }),
    );
    (sm as any)._enabled = true;
    (sm as any)._runId = 1;
    (sm as any)._token = 'tok';
    return sm;
  }

  const cases = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `t${i}` }) as any);

  it('uploadRemaining stops after three uploads in a row get no response', async () => {
    const uploadCaseFiles = vi.fn(async () => {
      throw refusedConnection();
    });
    const sm = makeManager({}, { uploadCaseFiles });
    await sm.uploadRemaining(cases(10));
    expect(uploadCaseFiles).toHaveBeenCalledTimes(3);
  });

  it('uploadRemaining keeps going while the dashboard answers, even with an error status', async () => {
    let call = 0;
    const uploadCaseFiles = vi.fn(async () => {
      call++;
      // Two connection failures, an answer, then two more: never three in a row.
      if (call === 3) throw new HttpError(500);
      if (call <= 5) throw new Error('socket hang up');
      return true;
    });
    const sm = makeManager({}, { uploadCaseFiles });
    await sm.uploadRemaining(cases(10));
    expect(uploadCaseFiles).toHaveBeenCalledTimes(10);
  });

  it('uploadRemaining stops once the dashboard says the run takes no more files (409)', async () => {
    const uploadCaseFiles = vi.fn(async () => {
      throw new HttpError(409);
    });
    const sm = makeManager({}, { uploadCaseFiles });
    await sm.uploadRemaining(cases(10));
    expect(uploadCaseFiles).toHaveBeenCalledTimes(1);
  });

  it('drain stops retrying once the HTTP client is closed', async () => {
    const sm = makeManager({
      closed: true,
      async postJSON() {
        throw new Error('budget spent');
      },
    });
    sm.queueEvent(completeEvent('undelivered'));
    // The drain's back-off alone would take over a minute.
    await sm.drain();
    expect(sm.lostResults).toBe(true);
  });
});

describe('StreamManager start refused', () => {
  beforeEach(cleanup);
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** What the manager warns when the dashboard answers its `/start` with `error`. */
  async function warningFor(error: Error): Promise<string> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const http = {
      async postJSON() {
        throw error;
      },
      async resolveAuth() {
        return null;
      },
    };
    const sm = new StreamManager(
      http as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions(),
    );
    sm.start(new Date().toISOString(), {}, 'instance');
    await sm.startPromise;
    expect(sm.enabled).toBe(false);
    return warn.mock.calls.flat().join('\n');
  }

  it('asks for an API key when the dashboard wants one (401)', async () => {
    expect(await warningFor(new HttpError(401))).toContain("Set the reporter's `apiKey` option");
  });

  it("prints the dashboard's own reason for a 403, not the API key advice", async () => {
    const refusal =
      'Request failed with status 403: With authentication off, this dashboard answers only on its local addresses.';
    const warning = await warningFor(new HttpError(403, refusal));
    expect(warning).toContain(refusal);
    expect(warning).not.toContain('apiKey');
  });
});

describe('StreamManager start asked again', () => {
  let lines: string[];

  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void lines.push(String(line)));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    fs.rmSync(getSetupFilePath(projectName), { force: true });
  });

  function makeManager(
    postJSON: (url: string, body: any) => Promise<any>,
    options: Partial<PiwiDashboardOptions> = {},
  ): StreamManager {
    return new StreamManager(
      { postJSON, resolveAuth: async () => null } as any,
      new StreamBuffer(projectName),
      new CrashRecovery(RECOVERY_SERVER, projectName),
      {} as any,
      new FileHandler(),
      makeOptions({ streamingBatchSize: 1_000_000, streamingBatchDelay: 3_600_000, ...options }),
    );
  }

  async function drain(sm: StreamManager): Promise<void> {
    const drained = sm.drain();
    await vi.runAllTimersAsync();
    await drained;
  }

  const beginEvent = (title: string) => ({ ...completeEvent(title), type: 'begin' }) as any;
  const linesWith = (text: string) => lines.filter((line) => line.includes(text));

  it('begins the registered run once the dashboard answers, with what queued meanwhile, saying once how late', async () => {
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const requests: string[] = [];
    const sent: string[] = [];
    const failures = [new Error('connect ECONNREFUSED 127.0.0.1:7494'), new HttpError(503), new HttpError(429)];
    const sm = makeManager(async (url, body) => {
      requests.push(url);
      const failure = failures.shift();
      if (failure) throw failure;
      if (url === '/api/test-runs/5/begin') return { runId: 5, streamToken: 'tok' };
      sent.push(...body.testCases.map((e: any) => `${e.type} ${e.title}`));
      return {};
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    sm.queueEvent(beginEvent('early'));
    sm.queueEvent(stepBeginEvent('a step'));
    sm.queueEvent(completeEvent('early'));

    // Tries at 0, 1 and 3 s fail; the one at 7 s is answered.
    await vi.advanceTimersByTimeAsync(6_900);
    expect(sm.enabled).toBe(false);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(sm.runId).toBe(5);
    await drain(sm);

    expect(requests.filter((url) => url === '/api/test-runs/5/begin')).toHaveLength(4);
    expect(requests).not.toContain('/api/test-runs/start');
    expect(sent).toEqual(['begin early', 'step-begin a step', 'complete early']);
    expect(linesWith('Live streaming could not start (connect ECONNREFUSED')).toHaveLength(1);
    expect(linesWith('Streaming started')).toEqual(['[Piwi Dashboard] Streaming started 7 s late, once the dashboard answered. Run ID: 5']);
    expect(sm.lostResults).toBe(false);
  });

  it('asks for a fresh run once the registered one cannot begin (409), and asks for that one again after', async () => {
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const requests: string[] = [];
    let starts = 0;
    const sm = makeManager(async (url) => {
      requests.push(url);
      if (url === '/api/test-runs/5/begin') throw new HttpError(409);
      if (url === '/api/test-runs/start' && ++starts === 1) throw new HttpError(502);
      return { runId: 8, streamToken: 'tok' };
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    await vi.advanceTimersByTimeAsync(1_100);

    expect(requests).toEqual(['/api/test-runs/5/begin', '/api/test-runs/start', '/api/test-runs/start']);
    expect(sm.runId).toBe(8);
    await drain(sm);
  });

  it('does not ask again for a /start the dashboard may have taken, its answer lost', async () => {
    const requests: string[] = [];
    const sm = makeManager(async (url) => {
      requests.push(url);
      throw new Error('Request to /api/test-runs/start timed out after 30000ms');
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toEqual(['/api/test-runs/start']);
    expect(sm.enabled).toBe(false);
    await drain(sm);
  });

  it('says an earlier try began the registered run when a /begin asked again is refused', async () => {
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const requests: string[] = [];
    const sm = makeManager(async (url) => {
      requests.push(url);
      if (requests.length === 1) throw new Error('Request to /api/test-runs/5/begin timed out after 30000ms');
      throw new HttpError(403, 'Invalid setup token');
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requests).toEqual(['/api/test-runs/5/begin', '/api/test-runs/5/begin']);
    expect(linesWith('began the run on an earlier try whose answer was lost')).toHaveLength(1);
    await drain(sm);
  });

  it('gives the registered run up at once when the server did not prove the desktop token, and asks again when it did not answer', async () => {
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const requests: string[] = [];
    const sm = makeManager(async (url) => {
      requests.push(url);
      throw new DesktopNotProvenError('http://localhost:3000', 'unproven');
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toEqual(['/api/test-runs/5/begin']);
    expect(sm.enabled).toBe(false);
    await drain(sm);

    cleanup();
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const asked: string[] = [];
    const again = makeManager(async (url) => {
      asked.push(url);
      if (asked.length === 1) throw new DesktopNotProvenError('http://localhost:3000', 'unreachable');
      return { runId: 5, streamToken: 'tok' };
    });
    again.start(new Date().toISOString(), {}, 'instance');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(asked).toEqual(['/api/test-runs/5/begin', '/api/test-runs/5/begin']);
    expect(again.runId).toBe(5);
    await drain(again);
  });

  it.each([400, 403, 404])('gives the stream up at once on a %i, keeping no event for it', async (status) => {
    const requests: string[] = [];
    const sm = makeManager(async (url) => {
      requests.push(url);
      throw new HttpError(status);
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    await sm.startPromise;
    sm.queueEvent(completeEvent('after'));
    await vi.advanceTimersByTimeAsync(120_000);
    await drain(sm);

    expect(requests).toEqual(['/api/test-runs/start']);
    expect(sm.enabled).toBe(false);
    expect((sm as any).pendingEvents.length).toBe(0);
    expect(linesWith('Live streaming is unavailable')).toHaveLength(1);
  });

  it('keeps what queues while the stream opens within maxStreamBufferBytes, shedding progress before results', async () => {
    const sm = makeManager(
      async () => {
        throw refusedConnection();
      },
      { maxStreamBufferBytes: 20_000 },
    );
    sm.start(new Date().toISOString(), {}, 'instance');
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 4; j++) sm.queueEvent(stepEndEvent(`step ${i}.${j}`));
      sm.queueEvent(completeEvent(`result ${i}`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const queue = (sm as any).pendingEvents;
    expect(queue.bytes).toBeLessThanOrEqual(20_000);
    expect(queue.snapshot().filter((e: any) => e.type === 'complete')).toHaveLength(50);
    expect(queue.droppedCount).toBeGreaterThan(0);
    expect(sm.lostResults).toBe(false);
    await drain(sm);
  });

  it('tries once more at once as the run ends, then gives the stream up for the batch', async () => {
    const requests: string[] = [];
    const sm = makeManager(async (url) => {
      requests.push(url);
      throw refusedConnection();
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    // Tries at 0 and 1 s; the next one waits until 3 s.
    await vi.advanceTimersByTimeAsync(1_500);
    sm.queueEvent(completeEvent('queued'));
    const drained = sm.drain();
    await vi.advanceTimersByTimeAsync(0);
    await drained;

    expect(requests).toHaveLength(3);
    expect(sm.enabled).toBe(false);
    expect(linesWith('Live streaming did not start before the run ended (connect ECONNREFUSED)')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(3);
  });

  it('opens the stream on its last try as the run ends, and drains what queued', async () => {
    const sent: string[] = [];
    let ending = false;
    const sm = makeManager(async (url, body) => {
      if (!ending) throw new HttpError(503);
      if (url === '/api/test-runs/start') return { runId: 3, streamToken: 'tok' };
      sent.push(...body.testCases.map((e: any) => e.title));
      return {};
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    sm.queueEvent(completeEvent('queued'));
    await vi.advanceTimersByTimeAsync(20_000);
    ending = true;
    await drain(sm);

    expect(sm.runId).toBe(3);
    expect(sent).toEqual(['queued']);
    expect(linesWith('Streaming started 20 s late')).toHaveLength(1);
  });
});

describe("StreamManager with the desktop app's token", () => {
  const TOKEN = 'pd_desktop_token';
  beforeEach(cleanup);
  afterEach(() => {
    cleanup();
    fs.rmSync(getSetupFilePath(projectName), { force: true });
  });

  it('keeps asking for /begin through a database error that came with a correct proof, and does not end live streaming', async () => {
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const seen: { url: string; authorization: string | undefined }[] = [];
    let begins = 0;
    const server = http.createServer(async (req, res) => {
      req.resume();
      seen.push({ url: req.url ?? '', authorization: req.headers['authorization'] as string | undefined });
      if (req.url === '/api/health') {
        const port = (server.address() as { port: number }).port;
        const proof = await desktopTokenProof(TOKEN, port, String(req.headers['x-piwi-desktop-challenge']));
        res.writeHead(503, { 'x-piwi-desktop-proof': proof });
        res.end('{}');
        return;
      }
      begins++;
      res.writeHead(begins === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(begins === 1 ? '{}' : JSON.stringify({ runId: 5, streamToken: 'tok' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const client = new HttpClient(url, new Logger(false), 30000, 1000, TOKEN);
      const sm = new StreamManager(
        client,
        new StreamBuffer(projectName),
        new CrashRecovery(url, projectName),
        {} as any,
        new FileHandler(),
        makeOptions({ serverUrl: url, apiKey: TOKEN, streamingBatchSize: 1_000_000, streamingBatchDelay: 3_600_000 }),
      );
      sm.start(new Date().toISOString(), {}, 'instance');
      await sm.startPromise;
      expect(sm.enabled).toBe(true);
      expect(sm.runId).toBe(5);
      expect(begins).toBe(2);
      expect(seen.filter((r) => r.url.endsWith('/begin')).map((r) => r.authorization)).toEqual([
        `Bearer ${TOKEN}`,
        `Bearer ${TOKEN}`,
      ]);
      await sm.drain();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(recoveryFilePath(url, projectName), { force: true });
    }
  }, 15_000);
});
