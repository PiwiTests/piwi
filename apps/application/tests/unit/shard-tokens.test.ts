import { describe, test, expect } from 'vitest';

delete process.env.PIWI_DATABASE_URL;
const { shardTokenDigest, matchesShardToken, matchesStreamToken, readShardTokensFromMeta, streamTokenDigest } =
  await import('../../server/utils/shard-tokens');
const { runEventBus } = await import('../../server/utils/run-events');

describe('shard tokens are kept as digests', () => {
  test('a stored digest matches its token, and only its token', () => {
    const stored = new Set([shardTokenDigest('shard-token-a')]);
    expect(matchesShardToken(stored, 'shard-token-a')).toBe(true);
    expect(matchesShardToken(stored, 'shard-token-b')).toBe(false);
    // Reading the stored value back does not give a usable token.
    expect(matchesShardToken(stored, shardTokenDigest('shard-token-a'))).toBe(false);
  });

  test('a plain entry stored by an older build still matches', () => {
    const stored = readShardTokensFromMeta({ shardTokens: ['legacy-token'] });
    expect(matchesShardToken(stored, 'legacy-token')).toBe(true);
  });

  test('the in-memory run state holds digests', () => {
    runEventBus.cacheRunState(9001, { streamToken: 'primary', projectId: 1, shardTokens: new Set() });
    runEventBus.addShardToken(9001, 'shard-token-a');
    expect(runEventBus.getRunState(9001)?.shardTokens?.has('shard-token-a')).toBe(false);
    expect(runEventBus.isValidShardToken(9001, 'shard-token-a')).toBe(true);
    runEventBus.removeShardToken(9001, 'shard-token-a');
    expect(runEventBus.isValidShardToken(9001, 'shard-token-a')).toBe(false);
    runEventBus.clearRunState(9001);
  });
});

describe('the main stream token is kept as its digest', () => {
  test('a stored digest matches its token, and only its token', () => {
    const stored = streamTokenDigest('run-token');
    expect(stored).not.toContain('run-token');
    expect(matchesStreamToken(stored, 'run-token')).toBe(true);
    expect(matchesStreamToken(stored, 'other-token')).toBe(false);
    // Reading the stored value back does not give a usable token.
    expect(matchesStreamToken(stored, stored)).toBe(false);
  });

  test('a plain stored token still matches, and nothing matches a cleared one', () => {
    expect(matchesStreamToken('legacy-token', 'legacy-token')).toBe(true);
    expect(matchesStreamToken('legacy-token', 'other-token')).toBe(false);
    expect(matchesStreamToken(null, 'legacy-token')).toBe(false);
    expect(matchesStreamToken(streamTokenDigest('run-token'), undefined)).toBe(false);
  });
});
