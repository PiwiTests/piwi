import { gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { computeFault, isFaultAllowed, SLOW_FAULT_DELAY_MS } from '../src/internal/probe/faults.js';
import { fulfillHeaders, parseProbeTrace } from '../src/internal/probe/interception.js';
import {
  matchProbeItem,
  requestMatchesRoute,
  probeRunMetadata,
  createProbeState,
  markNavigated,
  shouldAct,
  type ProbePlan,
} from '../src/internal/probe/plan.js';
import { classifyProbeHandled, outcomeFromStatus } from '../src/internal/probe/mode.js';

describe('computeFault (fault application)', () => {
  const input = { status: 200, body: '{"total":42,"currency":"USD"}', contentType: 'application/json' };

  it('status-500 forces a 500', () => {
    const out = computeFault('status-500', input);
    expect(out.status).toBe(500);
    expect(out.changed).toBe(true);
  });

  it('status-500 on an already-500 response is a no-op', () => {
    expect(computeFault('status-500', { ...input, status: 500 }).changed).toBe(false);
  });

  it('empty-body blanks the body', () => {
    const out = computeFault('empty-body', input);
    expect(out.body).toBe('');
    expect(out.changed).toBe(true);
  });

  it('empty-body on an already-empty body is a no-op', () => {
    expect(computeFault('empty-body', { status: 200, body: '' }).changed).toBe(false);
  });

  it('drop-field removes the first JSON key', () => {
    const out = computeFault('drop-field', input);
    expect(JSON.parse(out.body)).toEqual({ currency: 'USD' });
    expect(out.changed).toBe(true);
  });

  it('drop-field on an array drops a key from each element', () => {
    const out = computeFault('drop-field', { status: 200, body: '[{"a":1,"b":2},{"a":3,"b":4}]' });
    expect(JSON.parse(out.body)).toEqual([{ b: 2 }, { b: 4 }]);
    expect(out.changed).toBe(true);
  });

  it('drop-field leaves non-JSON untouched and records no change', () => {
    const out = computeFault('drop-field', { status: 200, body: 'plain text' });
    expect(out.body).toBe('plain text');
    expect(out.changed).toBe(false);
  });

  it('stale-value replays a prior body', () => {
    const out = computeFault('stale-value', { ...input, priorBody: '{"total":1}' });
    expect(out.body).toBe('{"total":1}');
    expect(out.changed).toBe(true);
  });

  it('stale-value with no prior body is a no-op (records inconclusive)', () => {
    // Without a prior response to replay, stale-value cannot change the body, so
    // it must record as not applied rather than a false "not noticed".
    const out = computeFault('stale-value', input);
    expect(out.body).toBe(input.body);
    expect(out.changed).toBe(false);
  });

  it('slow delays the real response unchanged but counts as applied', () => {
    const out = computeFault('slow', input);
    expect(out.delayMs).toBe(SLOW_FAULT_DELAY_MS);
    expect(out.body).toBe(input.body);
    expect(out.status).toBe(200);
    expect(out.changed).toBe(true);
  });
});

describe('probe run stamp', () => {
  it('merges the piwiProbe flag into the run metadata', () => {
    expect(probeRunMetadata()).toEqual({ piwiProbe: true, piwiOrigin: { kind: 'probe' } });
    expect(probeRunMetadata({ scm: { branch: 'main' }, piwiOrigin: { kind: 'local' } })).toEqual({
      scm: { branch: 'main' },
      piwiProbe: true,
      piwiOrigin: { kind: 'probe' },
    });
  });

  it('derives the outcome from the test status', () => {
    expect(outcomeFromStatus('failed', true)).toBe('noticed');
    expect(outcomeFromStatus('timedOut', true)).toBe('noticed');
    expect(outcomeFromStatus('passed', true)).toBe('not-noticed');
    // An unapplied fault is inconclusive regardless of status.
    expect(outcomeFromStatus('passed', false)).toBe('inconclusive');
    expect(outcomeFromStatus('failed', false)).toBe('inconclusive');
  });
});

describe('fulfillHeaders (mutated response keeps its headers)', () => {
  it('preserves Set-Cookie and Location but drops the framing headers', () => {
    const out = fulfillHeaders(
      {
        'set-cookie': 'session=abc; HttpOnly',
        location: '/next',
        'content-type': 'application/json',
        'content-length': '123',
        'content-encoding': 'gzip',
      },
      null,
    );
    expect(out['set-cookie']).toBe('session=abc; HttpOnly');
    expect(out['location']).toBe('/next');
    expect(out['content-length']).toBeUndefined();
    expect(out['content-encoding']).toBeUndefined();
    // The original content-type survives when the fault set none.
    expect(out['content-type']).toBe('application/json');
  });

  it("applies the fault's content type over the original", () => {
    const out = fulfillHeaders({ 'content-type': 'text/html' }, 'application/json');
    expect(out['content-type']).toBe('application/json');
  });
});

describe('parseProbeTrace (applied fault + backend error)', () => {
  const header = (spans: unknown[]): string => gzipSync(Buffer.from(JSON.stringify(spans))).toString('base64');

  it('reads the applied fault label off the root span', () => {
    const info = parseProbeTrace(header([{ id: 'a', attrs: { 'piwi.probe.applied': 'dependency:redis' } }]));
    expect(info.appliedFault).toBe('dependency:redis');
    expect(info.serverError).toBe(false);
  });

  it('has no applied fault when the server signed but did not honor the probe', () => {
    // A root span with no applied marker: the request was verified but the fault
    // was not applied (probes off, route mismatch), so the probe is inconclusive.
    expect(parseProbeTrace(header([{ id: 'a', attrs: { 'piwi.probe': 'throw' } }])).appliedFault).toBeNull();
  });

  it('flags a backend error from an error root span or a 5xx status', () => {
    expect(parseProbeTrace(header([{ id: 'a', status: 'error', attrs: {} }])).serverError).toBe(true);
    expect(parseProbeTrace(header([{ id: 'a', attrs: { 'http.status_code': 503 } }])).serverError).toBe(true);
    expect(parseProbeTrace(header([{ id: 'a', attrs: { 'http.status_code': 200 } }])).serverError).toBe(false);
  });

  it('is empty for no header, a child-only span, or malformed input', () => {
    expect(parseProbeTrace(undefined)).toEqual({ appliedFault: null, serverError: false });
    expect(parseProbeTrace(header([{ id: 'c', parentId: 'a', attrs: { 'piwi.probe.applied': 'throw' } }]))).toEqual({
      appliedFault: null,
      serverError: false,
    });
    expect(parseProbeTrace('garbage')).toEqual({ appliedFault: null, serverError: false });
  });
});

describe('classifyProbeHandled (server-fault resilience)', () => {
  it('is graceful with no adverse signal', () => {
    expect(classifyProbeHandled({ consoleErrors: 0, dialogs: 0, backendError: false })).toBe('graceful');
  });

  it('is degraded on a console error, a dialog, or a backend error', () => {
    expect(classifyProbeHandled({ consoleErrors: 1, dialogs: 0, backendError: false })).toBe('degraded');
    expect(classifyProbeHandled({ consoleErrors: 0, dialogs: 1, backendError: false })).toBe('degraded');
    expect(classifyProbeHandled({ consoleErrors: 0, dialogs: 0, backendError: true })).toBe('degraded');
    expect(classifyProbeHandled({ consoleErrors: 0, dialogs: 0, backendError: false, blankPage: true })).toBe(
      'degraded',
    );
  });

  it('is unhandled on an uncaught page error, or a backend error that left the page blank', () => {
    expect(classifyProbeHandled({ consoleErrors: 0, dialogs: 0, backendError: false, pageErrors: 1 })).toBe(
      'unhandled',
    );
    expect(classifyProbeHandled({ consoleErrors: 0, dialogs: 0, backendError: true, blankPage: true })).toBe(
      'unhandled',
    );
  });
});

describe('isFaultAllowed (reporter-side allow-list)', () => {
  it('accepts known faults at their level', () => {
    expect(isFaultAllowed('client', 'status-500')).toBe(true);
    expect(isFaultAllowed('server', 'dependency')).toBe(true);
    // `replay` is a known server fault (the instrumentation may not apply it, but
    // the reporter must not refuse a plan that names it).
    expect(isFaultAllowed('server', 'replay')).toBe(true);
  });

  it('refuses a fault outside the level vocabulary', () => {
    expect(isFaultAllowed('client', 'dependency')).toBe(false);
    expect(isFaultAllowed('server', 'status-500')).toBe(false);
    expect(isFaultAllowed('client', 'made-up')).toBe(false);
  });
});

describe('matchProbeItem', () => {
  const plan: ProbePlan = {
    budget: 50,
    items: [
      { testCaseId: 1, testTitle: 'checkout › happy path', filePath: 'tests/checkout.spec.ts', suitePath: [], routeKey: 'POST /api/orders', fault: 'status-500', nth: 1 },
      { testCaseId: 2, testTitle: 'cart › coupon', filePath: 'tests/cart.spec.ts', suitePath: [], routeKey: 'POST /api/coupons', fault: 'empty-body', nth: 1 },
    ],
  };

  it('matches on file path plus title', () => {
    expect(matchProbeItem(plan, { title: 'cart › coupon', filePath: 'tests/cart.spec.ts' })?.testCaseId).toBe(2);
  });

  it('never matches a shared title across a different file', () => {
    // Two specs with the same leaf title: matching by title alone would be
    // ambiguous, so the file path decides which plan item is the right one.
    const shared: ProbePlan = {
      budget: 50,
      items: [
        { testCaseId: 10, testTitle: 'loads', filePath: 'tests/orders.spec.ts', suitePath: [], routeKey: 'GET /api/orders', fault: 'status-500', nth: 1 },
        { testCaseId: 20, testTitle: 'loads', filePath: 'tests/invoices.spec.ts', suitePath: [], routeKey: 'GET /api/invoices', fault: 'status-500', nth: 1 },
      ],
    };
    expect(matchProbeItem(shared, { title: 'loads', filePath: 'tests/orders.spec.ts' })?.testCaseId).toBe(10);
    expect(matchProbeItem(shared, { title: 'loads', filePath: 'tests/invoices.spec.ts' })?.testCaseId).toBe(20);
    // A file the plan does not carry matches nothing, even on a known title.
    expect(matchProbeItem(shared, { title: 'loads', filePath: 'tests/other.spec.ts' })).toBeNull();
  });

  it('breaks a same-file title tie on the suite path', () => {
    const tie: ProbePlan = {
      budget: 50,
      items: [
        { testCaseId: 30, testTitle: 'saves', filePath: 'tests/app.spec.ts', suitePath: ['Orders'], routeKey: 'POST /api/orders', fault: 'status-500', nth: 1 },
        { testCaseId: 40, testTitle: 'saves', filePath: 'tests/app.spec.ts', suitePath: ['Invoices'], routeKey: 'POST /api/invoices', fault: 'status-500', nth: 1 },
      ],
    };
    expect(matchProbeItem(tie, { title: 'saves', filePath: 'tests/app.spec.ts', suitePath: ['Invoices'] })?.testCaseId).toBe(40);
  });

  it('returns null when nothing matches', () => {
    expect(matchProbeItem(plan, { title: 'no such test', filePath: 'tests/checkout.spec.ts' })).toBeNull();
  });
});

describe('requestMatchesRoute', () => {
  it('matches method and a dynamic segment', () => {
    expect(requestMatchesRoute('PATCH', 'https://app.example.com/api/orders/42', 'PATCH /api/orders/:id')).toBe(true);
    expect(requestMatchesRoute('GET', 'https://app.example.com/api/orders/42', 'PATCH /api/orders/:id')).toBe(false);
  });

  it('does not match a different path', () => {
    expect(requestMatchesRoute('POST', 'https://app.example.com/api/coupons', 'POST /api/orders')).toBe(false);
  });
});

describe('shouldAct (after first navigation, Nth match)', () => {
  it('never acts before the first navigation', () => {
    const state = createProbeState();
    expect(shouldAct(state, 2)).toBe(false);
  });

  it('acts only on the Nth match after navigation', () => {
    const state = createProbeState();
    markNavigated(state);
    expect(shouldAct(state, 2)).toBe(false); // 1st match
    expect(shouldAct(state, 2)).toBe(true); // 2nd match
    expect(shouldAct(state, 2)).toBe(false); // 3rd match
  });
});
