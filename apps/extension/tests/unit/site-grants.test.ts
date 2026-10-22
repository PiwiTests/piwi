import { describe, expect, it } from 'vitest';
import { canRevoke, siteGrants, type GrantHolders } from '../../src/options/site-grants';

const NONE: GrantHolders = { instance: null, desktop: null, editor: null, recording: null, replay: null };

describe('the sites Piwi Picker may run on', () => {
  it('lists every granted pattern once, by host', () => {
    const grants = siteGrants(
      ['https://shop.example/*', 'http://127.0.0.1:3000/*', 'https://admin.example/*', 'https://shop.example/*'],
      NONE,
    );
    expect(grants.map((g) => g.pattern)).toEqual([
      'http://127.0.0.1:3000/*',
      'https://admin.example/*',
      'https://shop.example/*',
    ]);
    expect(grants.every(canRevoke)).toBe(true);
  });

  it('keeps the site of a running recording or replay until it ends', () => {
    const [recorded, replayed, other] = siteGrants(
      ['https://a.example/*', 'https://b.example/*', 'https://c.example/*'],
      {
        ...NONE,
        recording: 'https://a.example/*',
        replay: 'https://b.example/*',
      },
    );
    expect(recorded).toMatchObject({ busy: 'recording' });
    expect(replayed).toMatchObject({ busy: 'replay' });
    expect([recorded, replayed, other].map((g) => canRevoke(g!))).toEqual([false, false, true]);
  });

  it('leaves the instance’s and the pairings’ origins to Disconnect and Unpair, one origin serving both', () => {
    const grants = siteGrants(['http://127.0.0.1:3000/*', 'http://127.0.0.1:4100/*', 'https://piwi.example/*'], {
      ...NONE,
      instance: 'http://127.0.0.1:3000/*',
      desktop: 'http://127.0.0.1:3000/*',
      editor: 'http://127.0.0.1:4100/*',
    });
    expect(grants.map((g) => g.uses)).toEqual([['instance', 'desktop'], ['editor'], []]);
    expect(grants.map(canRevoke)).toEqual([false, false, true]);
  });
});
