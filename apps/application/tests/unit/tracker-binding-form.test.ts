import { describe, expect, test } from 'vitest';
import { pruneDeclaredIssueTypes } from '~/utils/tracker-binding-form';

const SHOP_TYPES = [
  { id: '10004', name: 'Bug' },
  { id: '10001', name: 'Story' },
];

describe('pruneDeclaredIssueTypes', () => {
  test('keeps the types the new project lists, by id or by name, and drops the rest', () => {
    expect(pruneDeclaredIssueTypes(['10004', 'story', '20007', 'Epic'], SHOP_TYPES)).toEqual(['10004', 'story']);
  });

  test('keeps the order of the selection and leaves a fully listed one as it was', () => {
    expect(pruneDeclaredIssueTypes(['10001', '10004'], SHOP_TYPES)).toEqual(['10001', '10004']);
  });

  test('clears the selection when the new project’s types could not be loaded', () => {
    expect(pruneDeclaredIssueTypes(['10004'], null)).toEqual([]);
  });

  test('clears the selection when the new project lists no type', () => {
    expect(pruneDeclaredIssueTypes(['10004', 'Bug'], [])).toEqual([]);
  });

  test('matches an id exactly, not by its start', () => {
    expect(pruneDeclaredIssueTypes(['100'], SHOP_TYPES)).toEqual([]);
  });
});
