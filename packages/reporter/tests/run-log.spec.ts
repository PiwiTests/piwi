import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PIWI_RUN_LOG_ENV } from '../src/internal/config/env.js';
import { printRunLine, relayRunLog } from '../src/internal/support/run-log.js';

/**
 * The run's log, for the lines a worker prints outside any test's output: the global setup names a private file for
 * the workers, and prints each whole line they append to it, the last ones as it stops; a worker without one prints
 * nothing.
 */

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** Relay the run's log as the global setup does, into `printed`; returns the file the workers append to. */
function relay(printed: string[]): { file: string; stop: () => void } {
  const env: NodeJS.ProcessEnv = {};
  const stop = relayRunLog((line) => printed.push(line), env);
  stops.push(stop);
  return { file: env[PIWI_RUN_LOG_ENV]!, stop };
}

describe("the run's log", () => {
  it('prints each line the workers append, one line each, and those left as it stops', () => {
    const printed: string[] = [];
    const { file, stop } = relay(printed);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    printRunLine(file, 'Worker 1: live view lost: the instance did not answer.');
    printRunLine(file, 'Worker 2: live view\nlost');
    stop();
    expect(printed).toEqual(['Worker 1: live view lost: the instance did not answer.', 'Worker 2: live view lost']);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('prints a line a second after it was appended at most, and a line still being written once it is whole', async () => {
    const printed: string[] = [];
    const { file } = relay(printed);
    printRunLine(file, 'Worker 1: live view back.');
    fs.appendFileSync(file, 'Worker 2: live');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(printed).toEqual(['Worker 1: live view back.']);
    fs.appendFileSync(file, ' view back.\n');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(printed).toEqual(['Worker 1: live view back.', 'Worker 2: live view back.']);
  });

  it('prints nothing for a worker the global setup named no file for, and never throws', () => {
    expect(() => printRunLine(null, 'Worker 1: live view back.')).not.toThrow();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-log-'));
    try {
      expect(() => printRunLine(path.join(dir, 'gone', 'log.txt'), 'Worker 1: live view back.')).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
