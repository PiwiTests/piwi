import { expect, test } from 'vitest';
import { z } from 'zod';
import { newSubmissionId } from '../../app/utils/submission-id';

test('a submission id is a UUID the create route accepts, new each time', () => {
  const ids = new Set(Array.from({ length: 50 }, newSubmissionId));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(z.string().uuid().safeParse(id).success).toBe(true);
});
