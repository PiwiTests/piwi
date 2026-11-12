import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STOP_WORDS } from '../../app/utils/stop-words';
// Imported from the editor service's source: the words both editors say (VS Code imports them, JetBrains mirrors them).
import { RUN_STOP_WORDS } from '../../../../packages/editor/src/protocol';

/**
 * One word per concept on every surface: why a test stands stopped, by its reason, reads the same on the run page and
 * in the desktop app (`app/utils/stop-words.ts`), in both editors (the editor service's `RUN_STOP_WORDS` and the
 * JetBrains plugin's mirror), in Piwi Picker's Runs window (its English catalog) and on the terminal's stop line (the
 * reporter's `STOP_LINE_WORDS`). The words stay in each surface's own code; this test holds them together.
 */

const repo = path.resolve(__dirname, '../../../..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

/** The pairs `pattern` reads (reason, words) in a file's block, from `start` to the first `end` after it. */
function pairsIn(text: string, start: string, end: string, pattern: RegExp): Record<string, string> {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const block = text.slice(from, text.indexOf(end, from));
  return Object.fromEntries([...block.matchAll(pattern)].map((m) => [m[1]!, m[2]!]));
}

/** The reasons every surface words, the failure's own sentence apart. */
const REASONS = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause'] as const;

describe('the words of a stop', () => {
  const dashboard = Object.fromEntries(REASONS.map((r) => [r, STOP_WORDS[r]]));

  test('are the editors’ words', () => {
    expect(Object.fromEntries(REASONS.map((r) => [r, RUN_STOP_WORDS[r]]))).toEqual(dashboard);
    expect(RUN_STOP_WORDS.other).toBe(STOP_WORDS.other);
    const kotlin = read('apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/Glue.kt');
    const mirrored = pairsIn(kotlin, 'val RUN_STOP_WORDS = mapOf(', '\n    )', /"([\w-]+)" to "([^"]+)"/g);
    expect(mirrored).toEqual({ ...dashboard, other: STOP_WORDS.other });
  });

  test('are Piwi Picker’s words', () => {
    const catalog = JSON.parse(read('apps/extension/public/_locales/en/messages.json')) as Record<
      string,
      { message: string }
    >;
    const keys: Record<(typeof REASONS)[number] | 'other', string> = {
      breakpoint: 'runs_stoppedBreakpoint',
      step: 'runs_stoppedStep',
      pause: 'runs_stoppedPause',
      'run-to': 'runs_stoppedRunTo',
      'page-pause': 'runs_stoppedPagePause',
      other: 'runs_stoppedOther',
    };
    for (const [reason, key] of Object.entries(keys)) {
      expect(catalog[key]?.message, key).toBe(STOP_WORDS[reason as keyof typeof STOP_WORDS]);
    }
  });

  test('are the terminal’s words', () => {
    const reporter = read('packages/reporter/src/internal/capture/run-channel.ts');
    const line = pairsIn(reporter, 'const STOP_LINE_WORDS', '\n};', /'?([\w-]+)'?: '([^']+)'/g);
    expect(line).toEqual(dashboard);
  });
});
