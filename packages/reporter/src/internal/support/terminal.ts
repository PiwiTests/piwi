import { PIWI_TERMINAL_PROGRESS_ENV } from '../config/env.js';
import { detectCi } from './ci.js';

/**
 * What the run's terminal shows of the run besides its lines, outside CI and while the output is a terminal other than
 * a dumb one: the run's page as a link (OSC 8), and how far the run is (OSC 9;4) in the terminals known to show it.
 * `PIWI_TERMINAL_PROGRESS=off` turns both off, `on` shows the progress in any terminal.
 */
export interface TerminalFeatures {
  links: boolean;
  progress: boolean;
}

/** The terminals that show OSC 9;4: Windows Terminal and ConEmu in the tab and the taskbar, Ghostty atop the terminal. */
function readsProgress(env: NodeJS.ProcessEnv): boolean {
  return !!env.WT_SESSION || env.ConEmuANSI === 'ON' || env.TERM_PROGRAM === 'ghostty';
}

export function terminalFeatures(env: NodeJS.ProcessEnv, isTerminal: boolean): TerminalFeatures {
  const setting = env[PIWI_TERMINAL_PROGRESS_ENV]?.trim().toLowerCase();
  if (!isTerminal || detectCi(env) || env.TERM === 'dumb' || ['off', 'false', '0', 'no'].includes(setting ?? '')) {
    return { links: false, progress: false };
  }
  return { links: true, progress: ['on', 'true', '1', 'yes'].includes(setting ?? '') || readsProgress(env) };
}

const OSC = '\u001b]';
const ST = '\u001b\\';

/** The sequence that takes the run's progress off the terminal. */
const TERMINAL_PROGRESS_CLEAR = `${OSC}9;4;0;0${ST}`;

// eslint-disable-next-line no-control-regex -- matches the control characters a terminal would act on
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** `text` as a link to `url` (OSC 8); for a URL or a text holding a control character, the text without them. */
export function terminalLink(url: string, text: string = url): string {
  // eslint-disable-next-line no-control-regex -- matches the control characters a terminal would act on
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  if (CONTROL.test(url) || plain !== text) return plain;
  return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`;
}

/**
 * The run's progress in the terminal (OSC 9;4): the share of its tests that ended, in the error state
 * once one failed, written as either changes, and cleared as the run ends.
 */
export class TerminalProgress {
  private readonly ended = new Map<string, boolean>();
  private failures = 0;
  private shown: string | null = null;

  constructor(
    private readonly total: number,
    private readonly write: (text: string) => void,
  ) {}

  /** A test ended for good (`failed`, how), counted once by its id, its latest outcome in place of an earlier one. */
  testEnded(id: string, failed: boolean): void {
    if (this.ended.get(id)) this.failures--;
    if (failed) this.failures++;
    this.ended.set(id, failed);
    const percent = this.total > 0 ? Math.min(100, Math.floor((this.ended.size / this.total) * 100)) : 0;
    this.show(`${this.failures > 0 ? 2 : 1};${percent}`);
  }

  /** The run started: the bar shows at 0. */
  begin(): void {
    this.show('1;0');
  }

  /** The run ended: the bar goes, written through `write` (the process's end writes synchronously). */
  end(write: (text: string) => void = this.write): void {
    if (this.shown === null) return;
    this.shown = null;
    write(TERMINAL_PROGRESS_CLEAR);
  }

  private show(state: string): void {
    if (this.shown === state) return;
    this.shown = state;
    this.write(`${OSC}9;4;${state}${ST}`);
  }
}
