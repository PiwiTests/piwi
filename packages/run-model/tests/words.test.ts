import { describe, expect, it } from 'vitest';
import { RUN_WORDS_EN, englishRunSpeaker as en } from '../src/words';

describe('the run model’s words in English', () => {
  it('says a message with its placeholders filled by name, an absent one left empty', () => {
    expect(en.say('runs_failedAt', { place: 'tests/cart.spec.ts:12' })).toBe('Failed at tests/cart.spec.ts:12');
    expect(en.say('runs_failedAt', { PLACE: 'a.ts:1' })).toBe('Failed at a.ts:1');
    expect(en.say('runs_failedAt')).toBe('Failed at ');
    expect(en.say('runs_stateRunning')).toBe('Running');
    // A value is no message: its own `$name$` stays as it is.
    expect(en.say('runs_driverTool', { tool: '$tool$' })).toBe('$tool$ drives this stop');
  });

  it('lists names as English does', () => {
    expect(en.list([])).toBe('');
    expect(en.list(['you'])).toBe('you');
    expect(en.list(['you', 'the desktop app'])).toBe('you and the desktop app');
    expect(en.list(['an agent', 'Visual Studio Code', 'Piwi Picker'])).toBe(
      'an agent, Visual Studio Code, and Piwi Picker',
    );
  });

  it('names each placeholder as `$name$`, in letters, digits and underscores', () => {
    for (const [key, message] of Object.entries(RUN_WORDS_EN)) {
      const stray = message.replace(/\$[A-Za-z0-9_]+\$/g, '');
      expect(stray, key).not.toContain('$');
    }
  });
});
