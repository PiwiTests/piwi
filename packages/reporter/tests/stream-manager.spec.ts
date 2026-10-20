import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StreamManager } from '../src/internal/streaming/stream-manager.js';
import { StreamBuffer } from '../src/internal/streaming/stream-buffer.js';
import { CrashRecovery, recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import { FileHandler } from '../src/internal/files/file-handler.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import { HttpError } from '../src/internal/transport/http-client.js';
import type { PiwiDashboardOptions } from '../src/public/options.js';
import type { CompleteStreamEvent, StepBeginStreamEvent, StepEndStreamEvent } from '../src/types/wire.js';

const projectName = 'piwi-stream-test-' + process.pid;
const projectHash = hashForProject(projectName);
const RECOVERY_SERVER = 'http://localhost:3000';

function cleanup(): void {
  const tmp = os.tmpdir();
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
    expect(fs.readdirSync(os.tmpdir()).some((f) => f.startsWith(`piwi-dashboard-stream-${projectHash}`))).toBe(false);
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
    const staleFile = path.join(os.tmpdir(), `piwi-dashboard-stream-${projectHash}-1.jsonl`);
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

  it('keeps sending step events to a dashboard that does not say', async () => {
    const { sm, requests } = makeEnabledManager(() => ({ success: true }));
    sm.queueEvent(completeEvent('a'));
    await sm.flush();
    sm.queueEvent(stepEndEvent('s'));
    await sm.drain();
    expect(sent(requests)).toEqual(['complete a', 'step-end s']);
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
    postJSON: (url: string, body: any) => Promise<any>,
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
        throw new Error('connect ECONNREFUSED');
      }, buffer);
      for (const event of events) sm.queueEvent(event);
      const drained = sm.drain();
      await vi.runAllTimersAsync();
      await drained;
      return { sm, buffer };
    }

    it('flags undelivered results so the run is not finalized without them', async () => {
      const { sm, buffer } = await drainAgainstDeadServer([completeEvent('undelivered')]);
      expect(sm.lostResults).toBe(true);
      expect(buffer.load().map((e) => e.title)).toEqual(['undelivered']);
    });

    it('does not flag lost results when only progress events are left', async () => {
      const { sm } = await drainAgainstDeadServer([{ type: 'step-end', title: 'step' }]);
      expect(sm.lostResults).toBe(false);
    });
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
      throw new Error('connect ECONNREFUSED');
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
