import { describe, expect, test } from 'vitest';
import { parseRunMainToHub, parseRunToHub, readRunPage } from '../src/run-channel';
import { parseHubMessage, type HubSession } from '../src/run-hub';

/**
 * A run's page on the instance it reports to: the run's own process names it to the hub (`run-page`), the hub passes it
 * on with the run (`HubSession.page`), and every surface opens it. And whether an editor took a pick on an image.
 */

const line = (value: unknown) => JSON.stringify(value);

describe('a run’s page', () => {
  test('is a positive number and an http(s) address, nothing else', () => {
    expect(readRunPage({ id: 78, url: 'https://piwi.example.com/test-runs/78' })).toEqual({
      id: 78,
      url: 'https://piwi.example.com/test-runs/78',
    });
    expect(readRunPage({ id: 1, url: 'http://127.0.0.1:7494/test-runs/1', extra: true })).toEqual({
      id: 1,
      url: 'http://127.0.0.1:7494/test-runs/1',
    });
    for (const broken of [
      null,
      { id: 0, url: 'https://piwi/test-runs/0' },
      { id: 1.5, url: 'https://piwi/test-runs/1' },
      { id: '78', url: 'https://piwi/test-runs/78' },
      { id: 78, url: '/test-runs/78' },
      { id: 78, url: 'javascript:alert(1)' },
      { id: 78, url: 'https://piwi/test runs/78' },
      { id: 78, url: 'https://piwi/"><img>' },
      { id: 78, url: `https://piwi/${'a'.repeat(2048)}` },
    ]) {
      expect(readRunPage(broken), JSON.stringify(broken)).toBeNull();
    }
  });

  test('is a line of the run’s own process, read field by field', () => {
    expect(parseRunMainToHub(line({ type: 'run-page', id: 78, url: 'https://piwi.example.com/test-runs/78' }))).toEqual(
      {
        type: 'run-page',
        id: 78,
        url: 'https://piwi.example.com/test-runs/78',
      },
    );
    expect(parseRunMainToHub(line({ type: 'run-page', id: 78, url: 'file:///etc/passwd' }))).toBeNull();
  });

  test('reaches Piwi Picker with the run, and one that does not read is left out, the run kept', () => {
    const session: HubSession = {
      ref: 'ed-1',
      root: null,
      label: null,
      command: null,
      project: null,
      workers: [],
      ended: false,
    };
    const read = (page: unknown) =>
      (parseHubMessage(line({ type: 'session', session: { ...session, page } })) as { session: HubSession }).session;
    expect(read({ id: 78, url: 'https://piwi.example.com/test-runs/78' }).page).toEqual({
      id: 78,
      url: 'https://piwi.example.com/test-runs/78',
    });
    expect(read({ id: 78, url: 'javascript:alert(1)' })).not.toHaveProperty('page');
    expect(read(undefined)).not.toHaveProperty('page');
  });
});

describe('a pick on an image', () => {
  test('says whether an editor took its locator, and an answer that does not say still reads', () => {
    const answer = (taken: unknown) =>
      parseRunToHub(
        line({
          type: 'answer',
          request: 4,
          what: 'pick-at',
          value: { ok: true, message: 'm', locator: "getByRole('button')", taken },
        }),
      );
    expect(answer(false)).toMatchObject({ value: { locator: "getByRole('button')", taken: false } });
    expect(answer(true)).toMatchObject({ value: { taken: true } });
    expect((answer(undefined) as { value: object }).value).not.toHaveProperty('taken');
    expect((answer('yes') as { value: object }).value).not.toHaveProperty('taken');
    const hub = (taken: unknown) => parseHubMessage(line({ type: 'answer', id: 3, ok: true, message: 'm', taken }));
    expect(hub(false)).toMatchObject({ taken: false });
    expect(hub('no')).not.toHaveProperty('taken');
  });
});
