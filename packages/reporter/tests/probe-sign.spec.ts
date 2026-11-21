import { describe, it, expect } from 'vitest';
import { buildProbeHeader, signProbeMessage } from '../src/internal/probe/sign';

describe('buildProbeHeader', () => {
  it('produces a base64 envelope whose signature matches the message', () => {
    const header = buildProbeHeader('shared-secret', { route: 'POST /api/orders', fault: 'status', nth: 1 }, 1_700_000_000_000);
    const envelope = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(typeof envelope.nonce).toBe('string');
    expect(envelope.ts).toBe(1_700_000_000_000);
    expect(JSON.parse(envelope.specJson)).toEqual({ route: 'POST /api/orders', fault: 'status', nth: 1 });
    const expected = signProbeMessage('shared-secret', envelope.nonce, envelope.ts, envelope.specJson);
    expect(envelope.sig).toBe(expected);
  });

  it('a different secret produces a different signature', () => {
    const spec = { fault: 'throw' };
    const now = 1_700_000_000_000;
    const a = JSON.parse(Buffer.from(buildProbeHeader('a', spec, now), 'base64').toString('utf8'));
    // Re-sign the same nonce/ts with a different secret; the signature must differ.
    expect(signProbeMessage('b', a.nonce, a.ts, a.specJson)).not.toBe(a.sig);
  });
});
