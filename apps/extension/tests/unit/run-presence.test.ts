import { describe, expect, it } from 'vitest';
import type { HubPresence } from '@piwitests/core/run-hub';
import { driverOf, presenceLine, watchersLine } from '../../src/shared/run-presence.js';
import { setBrowserLanguage } from './setup-i18n.js';

const self: HubPresence = { kind: 'picker', name: 'Piwi Picker', self: true };
const picker: HubPresence = { kind: 'picker', name: 'Piwi Picker' };
const desktop: HubPresence = { kind: 'desktop', name: 'the desktop app' };
const agent: HubPresence = { kind: 'agent', name: 'an agent' };
const code: HubPresence = { kind: 'editor', name: 'Visual Studio Code' };

describe('who else has a run open', () => {
  it('leaves the window itself out, and says nothing when nobody else has it', () => {
    expect(presenceLine(undefined)).toBeNull();
    expect(presenceLine([self])).toBeNull();
  });

  it('names each tool once in the window’s words, an agent apart', () => {
    expect(presenceLine([self, desktop, agent])).toBe('Also open in the desktop app · An agent follows this run');
    expect(presenceLine([picker, picker, code])).toBe('Also open in Piwi Picker and Visual Studio Code');
    expect(presenceLine([agent])).toBe('An agent follows this run');
    expect(presenceLine([{ kind: 'other', name: 'A newer tool' }])).toBe('Also open in A newer tool');
  });

  it('names a kind in the window’s language, an editor by its own name', () => {
    setBrowserLanguage('de');
    expect(presenceLine([desktop, code])).toBe('Auch geöffnet in der Desktop-App und Visual Studio Code');
  });
});

describe('who watches a worker’s page', () => {
  it('says nobody as nothing, and the window itself as you, first', () => {
    expect(watchersLine(undefined)).toBeNull();
    expect(watchersLine([])).toBeNull();
    expect(watchersLine([self])).toBe('Watched by you');
    expect(watchersLine([desktop, self])).toBe('Watched by you and the desktop app');
    expect(watchersLine([agent, code, picker])).toBe('Watched by an agent, Visual Studio Code, and Piwi Picker');
  });
});

describe('who drives a stop', () => {
  it('is nobody, this window, an agent or another tool, each in the window’s words', () => {
    expect(driverOf({})).toBeNull();
    expect(driverOf({ driver: self })).toEqual({ who: 'self', words: 'You drive this stop' });
    expect(driverOf({ driver: agent })).toEqual({ who: 'agent', words: 'An agent drives this stop' });
    expect(driverOf({ driver: desktop })).toEqual({ who: 'other', words: 'The desktop app drives this stop' });
    expect(driverOf({ driver: code })).toEqual({ who: 'other', words: 'Visual Studio Code drives this stop' });
    expect(driverOf({ driver: picker })).toEqual({ who: 'other', words: 'Piwi Picker drives this stop' });
  });
});
