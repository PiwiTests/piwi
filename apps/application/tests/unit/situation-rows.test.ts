import { describe, test, expect } from 'vitest';
import { SITUATION_ROWS } from '~/utils/situation-rows';

const slots = SITUATION_ROWS.map((r) => r.slot);
const at = (slot: (typeof slots)[number]) => slots.indexOf(slot);

describe('SITUATION_ROWS: explanation, action, context', () => {
  test('every slot appears once', () => {
    expect(new Set(slots).size).toBe(slots.length);
  });

  test('the explanation comes before the next step', () => {
    expect(at('story')).toBe(0);
    expect(at('story')).toBeLessThan(at('next'));
    expect(at('situation')).toBeLessThan(at('next'));
  });

  test('the state sits right above the next step', () => {
    expect(at('state') + 1).toBe(at('next'));
  });

  test('every context line comes after the next step, the cluster and its ticket first', () => {
    for (const slot of ['cluster', 'issue', 'occurrences', 'history', 'teamCi', 'whatChanged', 'suite'] as const) {
      expect(at(slot), slot).toBeGreaterThan(at('next'));
    }
    // The execution page's Cluster line, else the cluster page's Issue line,
    // follows the next step.
    expect(at('cluster')).toBe(at('next') + 1);
    expect(at('issue')).toBe(at('cluster') + 1);
  });

  test('the team’s CI follows the test’s own history', () => {
    expect(at('teamCi')).toBe(at('history') + 1);
  });

  test('labels are sentence case', () => {
    for (const { label } of SITUATION_ROWS) expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    expect(SITUATION_ROWS.map((r) => r.label)).toContain('What changed');
  });
});
