import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, toValue } from 'vue';
import { triagePanelPatch } from '../../app/utils/cluster-triage';

/**
 * The cluster page sends only what the person changed: a status change no note,
 * so the server keeps the note as stored, with the lines Piwi added since the
 * page loaded, and a note edit no status, so a status Piwi set since stays.
 */

const requests: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('toValue', toValue);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('$fetch', async (url: string, init: { body: unknown }) => {
    requests.push({ url, body: init.body });
  });
});

afterEach(() => vi.unstubAllGlobals());

const { useClusterTriage } = await import('../../app/composables/useClusterTriage');
const { useApplyClusterTriage } = await import('../../app/composables/useApplyClusterTriage');

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
    expect(triagePanelPatch({ status: 'ignored', note: 'The cart API changed' }, stored)).toEqual({
      status: 'ignored',
      triageNote: 'The cart API changed',
    });
    expect(triagePanelPatch({ status: 'ignored', note: '  ' }, stored)).toEqual({
      status: 'ignored',
      triageNote: null,
    });
  });

  test('a note edit alone sends the note alone', () => {
    // Fix verification may have reopened or resolved the cluster since the page loaded.
    expect(triagePanelPatch({ status: 'open', note: 'The cart API changed' }, stored)).toEqual({
      triageNote: 'The cart API changed',
    });
  });

  test('nothing changed sends nothing', () => {
    expect(triagePanelPatch({ status: 'open', note: 'Looking into it ' }, stored)).toBeNull();
  });
});

describe('applying the triage of a cluster fixed before', () => {
  test('sends the line alone, which the server appends to the stored note, so the status stays as it is', async () => {
    const { applyTriage } = useApplyClusterTriage({ clusterId: () => 7, onApplied: () => {} });
    await applyTriage({ clusterId: 3, triageNote: 'Fixed by the cart refactor' } as never);
    expect(requests).toEqual([
      {
        url: '/api/failure-clusters/7/status',
        body: { appendTriageNote: 'Same as cluster #3: Fixed by the cart refactor' },
      },
    ]);
  });
});
