import { describe, expect, test } from 'vitest';
import { healEditKey, healSignature } from '../../shared/auto-heal';
import { suggestionHash } from '../../shared/handback-outcomes';
import { profilePictureVersion } from '../../shared/user-avatar';

describe('stored and published FNV-1a keys', () => {
  test('a handed-back suggestion keeps its stored key', () => {
    expect(suggestionHash(['tests/a.spec.ts:12', null, 3])).toBe('7792c488');
  });

  test('an auto-heal edit set keeps its signature and its edits their keys', () => {
    const edits = [
      { filePath: 'b.spec.ts', line: 4, suggestedLocator: "getByRole('button')" },
      { filePath: 'a.spec.ts', line: 9, suggestedLocator: "getByLabel('Name')" },
    ];
    expect(healSignature(edits)).toBe('6a465812');
    expect(healEditKey({ filePath: 'a.spec.ts', failingLocator: null, suggestedLocator: "getByLabel('Name')" })).toBe(
      'aae1df9b',
    );
  });

  test('a profile picture keeps its cache version', () => {
    expect(profilePictureVersion('https://avatars.githubusercontent.com/u/583231?v=4')).toBe('1xgtbvx');
  });
});
