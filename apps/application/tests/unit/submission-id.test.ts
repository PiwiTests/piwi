import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  holdSubmission,
  newSubmissionId,
  releaseSubmission,
  submissionHeld,
  submissionIdFor,
} from '../../app/utils/submission-id';

test('a submission id is a UUID the create route accepts, new each time', () => {
  const ids = new Set(Array.from({ length: 50 }, newSubmissionId));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(z.string().uuid().safeParse(id).success).toBe(true);
});

test('a form opened again while its filing is queued sends the same id, and a new one once it is done', () => {
  const first = submissionIdFor('test_run:7');
  expect(submissionIdFor('test_run:7')).not.toBe(first);
  holdSubmission('test_run:7', first);
  expect(submissionHeld('test_run:7')).toBe(true);
  expect(submissionIdFor('test_run:7')).toBe(first);
  expect(submissionIdFor('test_run:8')).not.toBe(first);
  releaseSubmission('test_run:7');
  expect(submissionIdFor('test_run:7')).not.toBe(first);
});

test('a held id outlives the page: a reload, or another tab, reads it from the browser storage', async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  vi.stubGlobal('localStorage', storage);
  try {
    holdSubmission('test_run:9', '00000000-0000-4000-8000-000000000001');
    // A new page: the module loaded again, its memory empty.
    vi.resetModules();
    const reloaded = await import('../../app/utils/submission-id');
    expect(reloaded.submissionIdFor('test_run:9')).toBe('00000000-0000-4000-8000-000000000001');
    reloaded.releaseSubmission('test_run:9');
    expect(store.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('an id another tab released, or one held past a day, is not sent again', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  try {
    vi.resetModules();
    const ids = await import('../../app/utils/submission-id');
    ids.holdSubmission('test_run:10', '00000000-0000-4000-8000-000000000002');
    // Another tab released it.
    store.clear();
    expect(ids.submissionHeld('test_run:10')).toBe(false);
    ids.holdSubmission('test_run:11', '00000000-0000-4000-8000-000000000003');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    expect(ids.submissionHeld('test_run:11')).toBe(false);
    expect(store.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
