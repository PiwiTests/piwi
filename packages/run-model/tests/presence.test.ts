import { describe, expect, it } from 'vitest';
import type { HubPresence } from '@piwitests/core/run-hub';
import { driverOf, givesBack, presenceLine, watchersLine } from '../src/presence';
import { englishRunSpeaker as en, type RunSpeaker } from '../src/words';

const self: HubPresence = { kind: 'picker', name: 'Piwi Picker', self: true };
const picker: HubPresence = { kind: 'picker', name: 'Piwi Picker' };
const desktop: HubPresence = { kind: 'desktop', name: 'the desktop app' };
const agent: HubPresence = { kind: 'agent', name: 'an agent' };
const code: HubPresence = { kind: 'editor', name: 'Visual Studio Code' };

describe('who else has a run open', () => {
  it('leaves the surface itself out, and says nothing when nobody else has it', () => {
    expect(presenceLine(undefined, en)).toBeNull();
    expect(presenceLine([self], en)).toBeNull();
  });

  it('names each tool once in the run model’s words, an agent apart', () => {
    expect(presenceLine([self, desktop, agent], en)).toBe('Also open in the desktop app · An agent follows this run');
    expect(presenceLine([picker, picker, code], en)).toBe('Also open in Piwi Picker and Visual Studio Code');
    expect(presenceLine([agent], en)).toBe('An agent follows this run');
    expect(presenceLine([{ kind: 'other', name: 'A newer tool' }], en)).toBe('Also open in A newer tool');
  });

  it('says it in the speaker’s words, an editor by its own name', () => {
    const shouting: RunSpeaker = {
      say: (key, args) => en.say(key, args).toUpperCase(),
      count: (key, count) => en.count(key, count).toUpperCase(),
      number: (value) => en.number(value),
      list: (items) => items.join(' + '),
    };
    expect(presenceLine([desktop, code], shouting)).toBe('ALSO OPEN IN THE DESKTOP APP + VISUAL STUDIO CODE');
  });
});

describe('who watches a worker’s page', () => {
  it('says nobody as nothing, and the surface itself as you, first', () => {
    expect(watchersLine(undefined, en)).toBeNull();
    expect(watchersLine([], en)).toBeNull();
    expect(watchersLine([self], en)).toBe('Watched by you');
    expect(watchersLine([desktop, self], en)).toBe('Watched by you and the desktop app');
    expect(watchersLine([agent, code, picker], en)).toBe('Watched by an agent, Visual Studio Code, and Piwi Picker');
  });
});

describe('who drives a stop', () => {
  it('is nobody, the surface itself, an agent or another tool, each in the run model’s words', () => {
    expect(driverOf({}, en)).toBeNull();
    expect(driverOf({ driver: self }, en)).toEqual({ who: 'self', words: 'You drive this stop' });
    expect(driverOf({ driver: agent }, en)).toEqual({ who: 'agent', words: 'An agent drives this stop' });
    expect(driverOf({ driver: desktop }, en)).toEqual({ who: 'other', words: 'The desktop app drives this stop' });
    // A name the hub gives in lower case starts the sentence capitalized.
    expect(driverOf({ driver: { kind: 'editor', name: 'the editor' } }, en)).toEqual({
      who: 'other',
      words: 'The editor drives this stop',
    });
    expect(driverOf({ driver: code }, en)).toEqual({ who: 'other', words: 'Visual Studio Code drives this stop' });
    expect(driverOf({ driver: picker }, en)).toEqual({ who: 'other', words: 'Piwi Picker drives this stop' });
  });
});

describe('Interact turned off', () => {
  it('gives the stop back while the surface drives it, or while nobody does and its input reached it', () => {
    expect(givesBack({ who: 'self' }, false)).toBe(true);
    expect(givesBack({ who: 'self' }, true)).toBe(true);
    expect(givesBack(null, true)).toBe(true);
    // Nobody drives and no input reached it: nothing to give back.
    expect(givesBack(null, false)).toBe(false);
    // Another tool or an agent took it: it is theirs, whatever input reached it.
    expect(givesBack({ who: 'agent' }, true)).toBe(false);
    expect(givesBack({ who: 'other' }, true)).toBe(false);
  });
});
