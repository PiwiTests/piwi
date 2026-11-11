import { describe, expect, it } from 'vitest';
import type { HubAction, HubStop } from '@piwitests/core/run-hub';
import { CONTROLS, FOLDED, FOLD_FROM, JOINED, STEERING, controlTitle, controlsOf } from '../src/controls';
import { englishRunSpeaker as en } from '../src/words';
import { stop, worker } from './fixtures';

const at = (intents: HubAction[] | undefined, over: Partial<HubStop> = {}): HubStop => ({
  ...stop('s1'),
  intents,
  ...over,
});

describe('the controls a worker takes', () => {
  it('is Pause while it runs, and End the test while a Pause waits in a call its worker can give up', () => {
    expect(controlsOf(worker({}), null, [])).toEqual(['pause']);
    expect(controlsOf(worker({ pausing: true }), null, [])).toEqual([]);
    const waiting = { title: 'Click', uri: null, line: null, since: null, endable: true };
    expect(controlsOf(worker({ pausing: true, waiting, intents: ['give-up'] }), null, [])).toEqual(['give-up']);
    expect(controlsOf(worker({ pausing: true, waiting }), null, [])).toEqual([]);
  });

  it('is Resume, Step and Finish at a stop, then what the stop takes, in the surface’s order', () => {
    const all: HubAction[] = ['mock', 'assert-region', 'assert', 'record', 'pick', 'end', 'front'];
    expect(controlsOf(worker({}), at(all), [])).toEqual([
      'resume',
      'step',
      'finish',
      'front',
      'end',
      'pick',
      'record',
      'assert',
      'assert-region',
      'mock',
    ]);
    expect(controlsOf(worker({}), at([]), [])).toEqual(['resume', 'step', 'finish']);
  });

  it('is Resume alone at a failure, which ends the test as it failed, beside what the stop takes', () => {
    expect(controlsOf(worker({}), at(['front', 'mock'], { reason: 'failure' }), [])).toEqual([
      'resume',
      'front',
      'mock',
    ]);
  });

  it('shows the actions in the test’s window a stop takes once watched, held', () => {
    expect(controlsOf(worker({}), at(['mock']), ['pick', 'assert'])).toEqual([
      'resume',
      'step',
      'finish',
      'pick',
      'assert',
      'mock',
    ]);
  });

  it('reads what an older service’s stop takes from the worker’s reporter', () => {
    const takes = worker({ intents: ['pick', 'record', 'mock', 'view'] });
    expect(controlsOf(takes, at(undefined, { bar: true }), [])).toEqual([
      'resume',
      'step',
      'finish',
      'pick',
      'record',
      'mock',
    ]);
    expect(controlsOf(takes, at(undefined), [])).toEqual(['resume', 'step', 'finish', 'mock']);
  });
});

describe('each control’s look', () => {
  it('has its words, Resume at a failure its own title', () => {
    expect(en.say(CONTROLS.resume.label)).toBe('Resume');
    expect(en.say(controlTitle('resume', stop('s1')))).toBe('Run on to the next breakpoint');
    expect(en.say(controlTitle('resume', { reason: 'failure' }))).toBe('Let the test end as it failed');
    expect(en.say(controlTitle('step', { reason: 'failure' }))).toBe('Run this call, and stop before the next one');
    expect(en.say(controlTitle('pause', null))).toBe('Stop the test before its next call');
    // End the test, at a stop or while a Pause waits, says the same, and explains each in its title.
    expect(CONTROLS['give-up'].label).toBe(CONTROLS.end.label);
    expect(CONTROLS['give-up'].title).not.toBe(CONTROLS.end.title);
  });

  it('groups the controls: Resume, Step and Finish joined among those that steer, Assert a region and Mock folded', () => {
    expect([...JOINED].every((what) => STEERING.has(what))).toBe(true);
    expect([...FOLDED].some((what) => STEERING.has(what))).toBe(false);
    expect(FOLD_FROM).toBe(5);
  });
});
