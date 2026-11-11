import type { HubStop, HubWorker } from '@piwitests/core/run-hub';

/** A worker of a run, running no test unless told otherwise. */
export const worker = (over: Partial<HubWorker>): HubWorker => ({
  worker: 0,
  parallelIndex: 0,
  state: 'running',
  pausing: false,
  intents: [],
  test: null,
  stop: null,
  ...over,
});

/** A Pause's stop, headless, named `since`. */
export const stop = (since: string): HubStop => ({
  reason: 'pause',
  title: 'Click',
  uri: 'file:///x.ts',
  line: 0,
  character: null,
  locator: null,
  bar: false,
  since,
});
