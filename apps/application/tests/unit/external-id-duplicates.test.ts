import { describe, expect, test } from 'vitest';
import { carryExternalIdDuplicates } from '#shared/external-id-duplicates';

const stored = {
  externalIdDuplicates: [{ externalId: '5', tests: [{ filePath: 'a.spec.ts', title: 'A' }] }],
};

describe('carryExternalIdDuplicates', () => {
  test('keeps what ingest recorded when the reporter metadata replaces the stored one', () => {
    expect(carryExternalIdDuplicates({ branch: 'main' }, stored)).toEqual({
      branch: 'main',
      externalIdDuplicates: stored.externalIdDuplicates,
    });
  });

  test('merges the reporter list with the stored one', () => {
    const next = { externalIdDuplicates: [{ externalId: '5', tests: [{ filePath: 'b.spec.ts', title: 'B' }] }] };
    expect(carryExternalIdDuplicates(next, stored)?.externalIdDuplicates).toEqual([
      {
        externalId: '5',
        tests: [
          { filePath: 'a.spec.ts', title: 'A' },
          { filePath: 'b.spec.ts', title: 'B' },
        ],
      },
    ]);
  });

  test('leaves the metadata as it is when nothing was recorded', () => {
    const next = { branch: 'main' };
    expect(carryExternalIdDuplicates(next, { other: 1 })).toBe(next);
    expect(carryExternalIdDuplicates(null, null)).toBeNull();
  });
});
