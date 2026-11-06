import { expect, test } from 'vitest';
import { z } from 'zod';
import { holdSubmission, newSubmissionId, releaseSubmission, submissionIdFor } from '../../app/utils/submission-id';

test('a submission id is a UUID the create route accepts, new each time', () => {
  const ids = new Set(Array.from({ length: 50 }, newSubmissionId));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(z.string().uuid().safeParse(id).success).toBe(true);
});

test('a form opened again while its filing is queued sends the same id, and a new one once it is done', () => {
  const first = submissionIdFor('test_run:7');
  expect(submissionIdFor('test_run:7')).not.toBe(first);
  holdSubmission('test_run:7', first);
  expect(submissionIdFor('test_run:7')).toBe(first);
  expect(submissionIdFor('test_run:8')).not.toBe(first);
  releaseSubmission('test_run:7');
  expect(submissionIdFor('test_run:7')).not.toBe(first);
});
