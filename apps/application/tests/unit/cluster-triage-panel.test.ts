import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { toValue } from 'vue';
import { triagePanelPatch } from '../../app/utils/cluster-triage';

/**
 * A status change on the cluster page sends no note, so the server keeps the
 * note as stored, with the lines Piwi added since the page loaded; only a note
 * the person edited is sent.
 */

const requests: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('toValue', toValue);
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('$fetch', async (url: string, init: { body: unknown }) => {
    requests.push({ url, body: init.body });
  });
});

afterEach(() => vi.unstubAllGlobals());

const { useClusterTriage } = await import('../../app/composables/useClusterTriage');

describe('useClusterTriage', () => {
  test('marks a cluster resolved or reopened without sending a note', async () => {
    const { setClusterStatus } = useClusterTriage(7);
    await setClusterStatus('resolved');
    await setClusterStatus('open');
    expect(requests).toEqual([
      { url: '/api/failure-clusters/7/status', body: { status: 'resolved' } },
      { url: '/api/failure-clusters/7/status', body: { status: 'open' } },
    ]);
  });
});

describe("the Triage panel's request", () => {
  const stored = { status: 'open', triageNote: 'Looking into it' };

  test('a status change sends the status alone', () => {
    expect(triagePanelPatch({ status: 'resolved', note: 'Looking into it' }, stored)).toEqual({ status: 'resolved' });
  });

  test('an edited note is sent, an emptied one as null', () => {
    expect(triagePanelPatch({ status: 'open', note: 'The cart API changed' }, stored)).toEqual({
      status: 'open',
      triageNote: 'The cart API changed',
    });
    expect(triagePanelPatch({ status: 'ignored', note: '  ' }, stored)).toEqual({
      status: 'ignored',
      triageNote: null,
    });
  });

  test('nothing changed sends nothing', () => {
    expect(triagePanelPatch({ status: 'open', note: 'Looking into it ' }, stored)).toBeNull();
  });
});
