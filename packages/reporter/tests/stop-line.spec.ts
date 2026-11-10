import { describe, expect, it } from 'vitest';
import { stopLine } from '../src/internal/capture/run-channel.js';

/** The terminal's line for a stop no pause bar shows: why the test stopped, where, and where to answer it. */
describe('the terminal’s stop line', () => {
  it('says why the test stopped, before which call, and the tool that answers it', () => {
    const at = (reason: Parameters<typeof stopLine>[0]) =>
      stopLine(reason, 'tests/cart.spec.ts:12', 'Click', 'Visual Studio Code');
    expect(at('breakpoint')).toBe(
      '[piwi] Stopped at a breakpoint at tests/cart.spec.ts:12 before Click: Resume, Step or Finish in Visual Studio Code.',
    );
    expect(at('step')).toContain('[piwi] Stopped after a step at tests/cart.spec.ts:12');
    expect(at('pause')).toContain('[piwi] Paused at tests/cart.spec.ts:12');
    expect(at('run-to')).toContain('[piwi] Stopped at the line it ran to at');
    expect(at('page-pause')).toContain('[piwi] Stopped at page.pause() at');
    expect(at('failure')).toBe(
      '[piwi] The test failed at tests/cart.spec.ts:12: Resume in Visual Studio Code lets it end as it failed.',
    );
  });
});
