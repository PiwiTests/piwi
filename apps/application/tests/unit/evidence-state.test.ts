import { describe, test, expect } from 'vitest';
import { resolveEvidenceState, evidenceAbsenceReason, EVIDENCE_CARD_IDS } from '../../shared/evidence-state';

describe('resolveEvidenceState', () => {
  test('present, fixture-captured — no trace chip', () => {
    const s = resolveEvidenceState('console', { hasData: true, source: 'fixture', fixturesActive: true });
    expect(s.state).toBe('present');
    if (s.state === 'present') expect(s.derivedFromTrace).toBe(false);
  });

  test('present, trace-derived — flags the trace chip', () => {
    const s = resolveEvidenceState('network', { hasData: true, source: 'trace', fixturesActive: false });
    expect(s.state).toBe('present');
    if (s.state === 'present') expect(s.derivedFromTrace).toBe(true);
  });

  test('no data and no fixtures — not captured, links to the connect wizard', () => {
    const s = resolveEvidenceState('console', { hasData: false, fixturesActive: false });
    expect(s.state).toBe('not-captured');
    if (s.state === 'not-captured') {
      expect(s.description).toContain('not captured for this project');
      expect(s.description).toContain('add the capture fixtures');
      expect(s.to).toBe('/settings/connect');
      expect(s.toLabel).toBeTruthy();
    }
  });

  test('no data but fixtures active — nothing happened', () => {
    const s = resolveEvidenceState('console', { hasData: false, fixturesActive: true });
    expect(s.state).toBe('nothing-happened');
    if (s.state === 'nothing-happened') {
      expect(s.description).toBe('The fixtures were active and the page logged nothing.');
    }
  });

  test('a plain-@playwright/test spec reads as not-captured while its fixture neighbor reads nothing-happened', () => {
    const plain = resolveEvidenceState('console', { hasData: false, fixturesActive: false });
    const neighbor = resolveEvidenceState('console', { hasData: false, fixturesActive: true });
    expect(plain.state).toBe('not-captured');
    expect(neighbor.state).toBe('nothing-happened');
  });

  test('backend logs with fixtures active but no data — not applicable', () => {
    const s = resolveEvidenceState('backendLogs', { hasData: false, fixturesActive: true });
    expect(s.state).toBe('not-applicable');
    if (s.state === 'not-applicable') {
      expect(s.description).toBe('Backend logs need a Piwi backend integration on the app under test.');
    }
  });

  test('backend logs without fixtures — not captured (fixtures come first)', () => {
    const s = resolveEvidenceState('backendLogs', { hasData: false, fixturesActive: false });
    expect(s.state).toBe('not-captured');
  });

  test('a declined capability reads declined, above the fixture and applicability logic', () => {
    const s = resolveEvidenceState('network', { hasData: false, fixturesActive: true, capability: 'declined' });
    expect(s.state).toBe('declined');
    if (s.state === 'declined') expect(s.description).toContain('declined for this project');
  });

  test('data still wins over a declined capability', () => {
    const s = resolveEvidenceState('network', {
      hasData: true,
      source: 'fixture',
      fixturesActive: true,
      capability: 'declined',
    });
    expect(s.state).toBe('present');
  });

  test('every card id resolves to one of the four states for every input combination', () => {
    for (const id of EVIDENCE_CARD_IDS) {
      for (const hasData of [true, false]) {
        for (const fixturesActive of [true, false]) {
          const s = resolveEvidenceState(id, { hasData, fixturesActive, source: hasData ? 'fixture' : undefined });
          expect(['present', 'not-captured', 'nothing-happened', 'not-applicable']).toContain(s.state);
        }
      }
    }
  });
});

describe('evidenceAbsenceReason', () => {
  test('is null when the card holds data', () => {
    expect(evidenceAbsenceReason('console', { hasData: true, source: 'fixture', fixturesActive: true })).toBeNull();
  });

  test('names the same cause the human card shows', () => {
    expect(evidenceAbsenceReason('console', { hasData: false, fixturesActive: false })).toContain('not captured');
    expect(evidenceAbsenceReason('console', { hasData: false, fixturesActive: true })).toContain('fixtures active');
    expect(evidenceAbsenceReason('backendLogs', { hasData: false, fixturesActive: true })).toContain(
      'backend integration',
    );
  });

  test('a declined capability reads "declined for this project"', () => {
    expect(evidenceAbsenceReason('console', { hasData: false, fixturesActive: true, capability: 'declined' })).toBe(
      'declined for this project',
    );
  });
});
