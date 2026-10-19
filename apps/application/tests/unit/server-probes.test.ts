import { describe, test, expect } from 'vitest';
import {
  resolveServerProbeSettings,
  serverProbeAllowed,
  isStateChangingRoute,
  DEFAULT_SERVER_PROBE_SETTINGS,
} from '#shared/server-probes';
import { selectServerProbeItems, type ProbeCandidate } from '#shared/handlers/probes';
import {
  detectUnprobedDependency,
  detectNotHandled,
  rankFinding,
  type ResilienceSignal,
} from '#shared/handlers/scenario-gaps';

describe('server-probe settings and gating', () => {
  test('resolveServerProbeSettings drops junk and defaults off', () => {
    expect(resolveServerProbeSettings(null)).toEqual(DEFAULT_SERVER_PROBE_SETTINGS);
    const s = resolveServerProbeSettings({ enabled: true, faults: ['status', 'nope'], routes: ['GET /a', 3] });
    expect(s.enabled).toBe(true);
    expect(s.faults).toEqual(['status']);
    expect(s.routes).toEqual(['GET /a']);
  });

  test('serverProbeAllowed enforces enabled, fault and route allow-lists', () => {
    const s = resolveServerProbeSettings({ enabled: true, faults: ['status', 'dependency'], routes: [] });
    expect(serverProbeAllowed(s, 'GET /api/cart', 'status')).toBe(true);
    expect(serverProbeAllowed(s, 'GET /api/cart', 'throw')).toBe(false);
    const disabled = resolveServerProbeSettings({ enabled: false, faults: ['status'] });
    expect(serverProbeAllowed(disabled, 'GET /api/cart', 'status')).toBe(false);
  });

  test('a route allow-listed with its query matches its route', () => {
    const s = resolveServerProbeSettings({
      enabled: true,
      faults: ['status'],
      routes: ['GET /api/users?page=%3Credacted%3E', 'GET /api/users?role=%3Credacted%3E'],
    });
    expect(s.routes).toEqual(['GET /api/users']);
    expect(serverProbeAllowed(s, 'GET /api/users', 'status')).toBe(true);
  });

  test('dependency faults on state-changing routes need the extra opt-in', () => {
    expect(isStateChangingRoute('POST /api/orders')).toBe(true);
    expect(isStateChangingRoute('GET /api/orders')).toBe(false);
    const s = resolveServerProbeSettings({ enabled: true, faults: ['dependency'], routes: [] });
    expect(serverProbeAllowed(s, 'POST /api/orders', 'dependency')).toBe(false);
    expect(serverProbeAllowed(s, 'GET /api/orders', 'dependency')).toBe(true);
    const optedIn = resolveServerProbeSettings({
      enabled: true,
      faults: ['dependency'],
      routes: [],
      dependencyOnStateChanging: true,
    });
    expect(serverProbeAllowed(optedIn, 'POST /api/orders', 'dependency')).toBe(true);
  });
});

describe('selectServerProbeItems', () => {
  const candidate = (id: number, routeKey: string): ProbeCandidate => ({
    testCaseId: id,
    testTitle: `t${id}`,
    filePath: `a${id}.spec.ts`,
    suitePath: [],
    routeKey,
    exposure: 10 - id,
    probed: false,
    changed: false,
  });

  test('emits server-level items only for allowed routes and faults', () => {
    const settings = resolveServerProbeSettings({ enabled: true, faults: ['status'], routes: ['GET /a'] });
    const items = selectServerProbeItems([candidate(1, 'GET /a'), candidate(2, 'GET /b')], settings);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ testCaseId: 1, routeKey: 'GET /a', fault: 'status', level: 'server' });
  });

  test('a disabled project emits nothing', () => {
    const items = selectServerProbeItems([candidate(1, 'GET /a')], DEFAULT_SERVER_PROBE_SETTINGS);
    expect(items).toEqual([]);
  });
});

describe('detectUnprobedDependency', () => {
  test('flags a called-but-never-probed dependency', () => {
    const gaps = detectUnprobedDependency([
      { dependencyKey: 'payments-svc', calledByRoutes: ['POST /api/orders', 'GET /api/cart'], probed: false },
      { dependencyKey: 'cache', calledByRoutes: ['GET /api/cart'], probed: true },
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detector).toBe('unprobed-dependency');
    expect(gaps[0]!.key).toBe('dependency:payments-svc');
  });
});

describe('resilience findings ranking (exposure × severity)', () => {
  test('unhandled outranks degraded at equal exposure', () => {
    const signals: ResilienceSignal[] = [
      { routeKey: 'POST /api/orders', handled: 'unhandled', testTitle: 'checkout', exposure: 5 },
      { routeKey: 'GET /api/cart', handled: 'degraded', testTitle: 'cart', exposure: 5 },
    ];
    const findings = detectNotHandled(signals).map((g, i) =>
      rankFinding(g, Math.min(1, (signals[i]!.exposure ?? 1) / 10)),
    );
    expect(findings[0]!.kind).toBe('finding');
    expect(findings[0]!.class).toBe('unhandled');
    expect(findings[1]!.class).toBe('degraded');
    // Same exposure, so severity decides: unhandled (1.0) scores 2× degraded (0.5).
    expect(findings[0]!.score).toBeCloseTo(findings[1]!.score * 2, 5);
  });
});
