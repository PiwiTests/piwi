import { describe, expect, it } from 'vitest';
import type { HubStop } from '@piwitests/core/run-hub';
import { tabStatus, workerStatus } from '../src/status';
import { englishRunSpeaker as en, type RunMessage } from '../src/words';
import { stop, worker } from './fixtures';

const said = (message: RunMessage) => en.say(message.key, message.args);
const at = (over: Partial<HubStop>) => worker({ state: 'stopped', stop: { ...stop('s1'), ...over } });

describe('a worker’s status card', () => {
  it('names where a test failed, held at its line', () => {
    const status = workerStatus(at({ reason: 'failure' }), 'tests/cart.spec.ts:12');
    expect(status).toMatchObject({ tone: 'failed', icon: 'x-circle', waiting: null });
    expect(said(status.message)).toBe('Failed at tests/cart.spec.ts:12');
  });

  it('says why a test stopped, an agent’s Pause, Step and Run to by their own words', () => {
    const words = (over: Partial<HubStop>) => said(workerStatus(at(over), 'x.ts:1').message);
    expect(words({ reason: 'breakpoint' })).toBe('Stopped at a breakpoint');
    expect(words({ reason: 'step' })).toBe('Stopped after a step');
    expect(words({ reason: 'pause' })).toBe('Paused');
    expect(words({ reason: 'run-to' })).toBe('Stopped at the line it ran to');
    expect(words({ reason: 'page-pause' })).toBe('Stopped at page.pause()');
    expect(words({ reason: 'other' })).toBe('Stopped');
    expect(words({ reason: 'pause', by: 'agent' })).toBe('Paused by the agent');
    expect(words({ reason: 'step', by: 'agent' })).toBe('Stopped after the agent’s step');
    expect(words({ reason: 'run-to', by: 'agent' })).toBe('Stopped at the line the agent ran it to');
    // Another stop an agent asked for reads as any stop.
    expect(words({ reason: 'breakpoint', by: 'agent' })).toBe('Stopped at a breakpoint');
    expect(workerStatus(at({ reason: 'pause' }), null)).toMatchObject({ tone: 'stopped', icon: 'pause' });
  });

  it('names the call a Pause waits in, and since when, for the surface to render', () => {
    const waiting = {
      title: "Click getByRole('button')",
      uri: null,
      line: null,
      since: '2026-11-11T10:00:00Z',
      endable: true,
    };
    const status = workerStatus(worker({ pausing: true, waiting }), null);
    expect(status).toEqual({
      tone: 'pausing',
      icon: 'clock',
      message: { key: 'runs_statePausingIn', args: { call: "Click getByRole('button')" } },
      waiting: { title: "Click getByRole('button')", since: '2026-11-11T10:00:00Z' },
    });
    expect(said(status.message)).toBe("Pausing: waits in Click getByRole('button')");
    expect(
      workerStatus(worker({ pausing: true, waiting: { ...waiting, since: null } }), null).waiting?.since,
    ).toBeNull();
  });

  it('says a Pause on its way, a running test, and a worker between tests', () => {
    const pausing = workerStatus(worker({ pausing: true }), null);
    expect(pausing).toMatchObject({ tone: 'pausing', icon: 'clock', waiting: null });
    expect(said(pausing.message)).toBe('Pausing…');
    expect(workerStatus(worker({}), null)).toMatchObject({ tone: 'running', icon: 'play' });
    // A newer service's state reads as running.
    expect(workerStatus(worker({ state: 'other' }), null)).toMatchObject({ tone: 'running', icon: 'play' });
    const between = workerStatus(worker({ state: 'between' }), null);
    expect(between).toMatchObject({ tone: 'between', icon: 'dot' });
    expect(said(between.message)).toBe('Between tests');
  });
});

describe('a worker’s tab', () => {
  it('says its state in a word, a failure without its place and a Pause without its call', () => {
    expect(said(tabStatus(at({ reason: 'failure' })).message)).toBe('Failed, held at its line');
    expect(tabStatus(at({ reason: 'failure' }))).toMatchObject({ tone: 'failed', icon: 'x-circle' });
    expect(said(tabStatus(at({ reason: 'pause', by: 'agent' })).message)).toBe('Paused by the agent');
    const waiting = { title: 'Click', uri: null, line: null, since: null, endable: true };
    expect(tabStatus(worker({ pausing: true, waiting }))).toEqual({
      tone: 'pausing',
      icon: 'clock',
      message: { key: 'runs_statePausing' },
    });
    expect(tabStatus(worker({}))).toEqual({ tone: 'running', icon: 'play', message: { key: 'runs_stateRunning' } });
    expect(tabStatus(worker({ state: 'between' }))).toEqual({
      tone: 'between',
      icon: 'dot',
      message: { key: 'runs_stateBetween' },
    });
  });
});
