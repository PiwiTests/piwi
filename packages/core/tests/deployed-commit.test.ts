import { describe, expect, test } from 'vitest';
import { deployedCommitOf } from '../src/deployed-commit';

describe('deployedCommitOf', () => {
  test('keeps 7 to 40 hexadecimal characters, lower-cased, and nothing else', () => {
    expect(deployedCommitOf(' 4E6F5164B ')).toBe('4e6f5164b');
    expect(deployedCommitOf('a'.repeat(40))).toBe('a'.repeat(40));
    for (const raw of ['abc123', 'a'.repeat(41), 'v1.2.3', 'g4e6f5164', null, 42])
      expect(deployedCommitOf(raw)).toBeNull();
  });
});
