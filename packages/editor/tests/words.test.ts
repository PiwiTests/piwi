import { describe, expect, test } from 'vitest';
import { EDITOR_ACTIONS } from '../src/actions';
import { CLIENT_WORDS, editorWords, fillWords } from '../src/words';

describe('the words both editors write', () => {
  test('name a stop control as the action catalog titles the action', () => {
    const titled = (vscode: string) => EDITOR_ACTIONS.find((a) => a.vscode === vscode)!.title;
    expect(CLIENT_WORDS['stop.run-to']).toBe(titled('piwi.runToCursor'));
    expect(CLIENT_WORDS['stop.end']).toBe(titled('piwi.endTest'));
  });

  test('leave only the values a client fills in', () => {
    const named = new Set(Object.values(CLIENT_WORDS).flatMap((w) => [...w.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
    expect([...named].sort()).toEqual(['by', 'cursor', 'lane', 'n', 'shard', 'steps']);
  });

  test('fill each value they name, and keep one they are not given', () => {
    expect(editorWords('ci-lane.shard', { shard: 1, lane: 2 })).toBe('shard 1, worker 2');
    expect(fillWords('Run to the {cursor}', {})).toBe('Run to the {cursor}');
  });
});
