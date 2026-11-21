import { describe, expect, test } from 'vitest';
import { effectScope } from 'vue';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useStopClock } from '../../app/composables/useStopClock';

/**
 * A stop's duration reads one clock wherever it shows: a test's row and its worker's lane panel turn over to the next
 * minute together.
 */

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../app/components', file), 'utf8');

describe('the stop clock', () => {
  test('is one clock for every reader', () => {
    const row = effectScope();
    const panel = effectScope();
    const a = row.run(() => useStopClock())!;
    const b = panel.run(() => useStopClock())!;
    expect(a).toBe(b);
    row.stop();
    panel.stop();
  });

  test('is what the row’s stop and the lane panel’s stop read', () => {
    for (const file of ['run/TestRowLivePause.vue', 'run/LanePanel.vue']) {
      const source = read(file);
      expect(source, file).toContain('useStopClock()');
      expect(source.match(/stopStoodMs\([^)]*\)/g), file).toEqual(
        expect.arrayContaining([expect.stringMatching(/stopStoodMs\([^,]+, (now|stopsNow)\.value\)/)]),
      );
    }
  });
});
