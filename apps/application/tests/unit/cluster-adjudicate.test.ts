import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ResolvedAiRole } from '../../types/api';
import type { ClusterForAdjudication } from '../../server/utils/cluster-adjudicate';

const provider = vi.hoisted(() => ({
  text: '{"merge":true,"confidence":"high","reason":"same root cause"}',
  calls: [] as Array<{ system: string; user: string }>,
}));

vi.mock('../../server/utils/ai-provider', () => ({
  callAiProvider: async (_role: unknown, opts: { system: string; user: string }) => {
    provider.calls.push({ system: opts.system, user: opts.user });
    return { text: provider.text };
  },
}));

const { adjudicateClusterPair } = await import('../../server/utils/cluster-adjudicate');

const role: ResolvedAiRole = {
  provider: 'openai',
  apiKey: 'k',
  model: 'test-reason',
  baseUrl: null,
  temperature: null,
};

const minimal: ClusterForAdjudication = { signature: 'sig-a', errorType: 'assertion', sampleError: 'boom' };

beforeEach(() => {
  provider.text = '{"merge":true,"confidence":"high","reason":"same root cause"}';
  provider.calls.length = 0;
});

describe('adjudicateClusterPair prompt building', () => {
  test('a minimal cluster omits locator, usage and affected-test lines', async () => {
    await adjudicateClusterPair(role, minimal, minimal);
    const { user } = provider.calls[0]!;
    expect(user).not.toContain('- locator:');
    expect(user).not.toContain('affects');
    expect(user).not.toContain('most-affected tests');
    expect(user).not.toContain('Overlap between');
  });

  test('includes the locator, usage totals and affected tests when present', async () => {
    const rich: ClusterForAdjudication = {
      ...minimal,
      selector: "getByRole('button')",
      totalTests: 3,
      totalRuns: 5,
      affectedTests: [{ file: 'a.spec.ts', title: 'does the thing', occurrences: 4 }],
    };
    await adjudicateClusterPair(role, rich, minimal);
    const { user } = provider.calls[0]!;
    expect(user).toContain("- locator: getByRole('button')");
    expect(user).toContain('- affects 3 distinct test(s) across 5 run(s)');
    expect(user).toContain('- most-affected tests:');
    expect(user).toContain('  - a.spec.ts › does the thing (4×)');
  });

  test('omits the usage line when only one of totalTests/totalRuns is set', async () => {
    await adjudicateClusterPair(role, { ...minimal, totalTests: 3 }, minimal);
    expect(provider.calls[0]!.user).not.toContain('affects');
  });

  test('falls back to "unknown" when errorType is null', async () => {
    await adjudicateClusterPair(role, { ...minimal, errorType: null }, minimal);
    expect(provider.calls[0]!.user).toContain('- error type: unknown');
  });

  test('includes an overlap section only when overlap is passed', async () => {
    await adjudicateClusterPair(role, minimal, minimal, { sharedTests: 2, sharedRuns: 1 });
    const { user } = provider.calls[0]!;
    expect(user).toContain('Overlap between the two clusters:');
    expect(user).toContain('- 2 distinct test(s) have failures in both clusters');
    expect(user).toContain('- both clusters produced failures together in 1 run(s)');
  });

  test('truncates the sample error to 1500 chars', async () => {
    await adjudicateClusterPair(role, { ...minimal, sampleError: 'x'.repeat(2000) }, minimal);
    const line = provider.calls[0]!.user.split('\n').find((l) => l.startsWith('- sample error:'))!;
    expect(line.length).toBeLessThanOrEqual('- sample error: '.length + 1500);
  });

  test('a cluster without a sample error renders an empty sample line rather than "null"', async () => {
    await adjudicateClusterPair(role, { ...minimal, sampleError: null }, minimal);
    expect(provider.calls[0]!.user).toContain('- sample error: \n');
  });
});

describe('adjudicateClusterPair response parsing', () => {
  test('parses a valid verdict', async () => {
    const result = await adjudicateClusterPair(role, minimal, minimal);
    expect(result).toEqual({ merge: true, confidence: 'high', reason: 'same root cause' });
  });

  test('coerces an invalid confidence value to low', async () => {
    provider.text = '{"merge":false,"confidence":"very sure","reason":"nope"}';
    const result = await adjudicateClusterPair(role, minimal, minimal);
    expect(result).toEqual({ merge: false, confidence: 'low', reason: 'nope' });
  });

  test('a missing reason becomes an empty string', async () => {
    provider.text = '{"merge":true,"confidence":"medium"}';
    const result = await adjudicateClusterPair(role, minimal, minimal);
    expect(result?.reason).toBe('');
  });

  test('truncates an overlong reason to 500 chars', async () => {
    provider.text = JSON.stringify({ merge: true, confidence: 'high', reason: 'y'.repeat(800) });
    const result = await adjudicateClusterPair(role, minimal, minimal);
    expect(result?.reason.length).toBe(500);
  });

  test('a non-boolean merge field returns null', async () => {
    provider.text = '{"merge":"yes","confidence":"high","reason":"x"}';
    expect(await adjudicateClusterPair(role, minimal, minimal)).toBeNull();
  });

  test('malformed JSON returns null instead of throwing', async () => {
    provider.text = 'not json';
    expect(await adjudicateClusterPair(role, minimal, minimal)).toBeNull();
  });
});
