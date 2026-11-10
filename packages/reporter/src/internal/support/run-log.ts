import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PIWI_RUN_LOG_ENV } from '../config/env.js';
import {
  appendPrivateFile,
  keepPrivateFileLive,
  privateTempDir,
  readPrivateFile,
  sweepStalePrivateFiles,
  writePrivateFile,
} from './private-file.js';

/** How the run's log files are named, a random part following. */
const RUN_LOG_PREFIX = 'piwi-run-log-';

/**
 * The run's log, for the lines a worker prints about itself. Playwright gives what a worker writes while a test runs
 * to that test, as the test's own output, whichever stream it writes to; what the runner's process writes goes to the
 * run's log alone. So the global setup, which runs in that process, names a private file for the workers
 * (`PIWI_RUN_LOG`, `relayRunLog`) and prints each whole line they append to it (`printRunLine`), a second later at
 * most, the last ones as that process exits.
 */

/** How often the runner's process prints the lines the workers appended. */
const READ_MS = 1000;

/** Append `line` to the run's log the global setup relays through `file`, when it relays one. Never throws. */
export function printRunLine(file: string | null, line: string): void {
  if (!file) return;
  try {
    appendPrivateFile(file, `${line.replace(/[\r\n]+/g, ' ')}\n`);
  } catch {
    // A line that cannot be written is not printed.
  }
}

/**
 * Print with `print` each line the workers that start from now on append to the run's log: a new private file, named
 * in `env` for them, read every `READ_MS`. Returns what prints the lines left and removes the file.
 */
export function relayRunLog(print: (line: string) => void, env: NodeJS.ProcessEnv = process.env): () => void {
  sweepStalePrivateFiles(RUN_LOG_PREFIX);
  const file = path.join(privateTempDir(), `${RUN_LOG_PREFIX}${randomBytes(12).toString('hex')}.txt`);
  writePrivateFile(file, '');
  env[PIWI_RUN_LOG_ENV] = file;
  let printed = 0;
  const flush = (): void => {
    let text: string;
    try {
      const found = readPrivateFile(file);
      if (!found || !('text' in found)) return;
      text = found.text;
      keepPrivateFileLive(file);
    } catch {
      return;
    }
    // Whole lines alone: one a worker is still writing waits for the next read.
    const end = text.lastIndexOf('\n') + 1;
    if (end <= printed) return;
    const lines = text.slice(printed, end).split('\n');
    printed = end;
    for (const line of lines) if (line) print(line);
  };
  const timer = setInterval(flush, READ_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    flush();
    fs.rmSync(file, { force: true });
  };
}
