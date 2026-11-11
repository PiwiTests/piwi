import { PIWI_TERMINAL_PROGRESS_ENV } from '../config/env.js';
import { detectCi } from './ci.js';

/**
 * What the run's terminal shows of the run besides its lines, outside CI and while the output is a terminal: the run's
 * page as a link (OSC 8), and how far the run is in the terminal's tab or taskbar (OSC 9;4), only in the terminals
 * known to read it, since an older one may read OSC 9 as a notification. `PIWI_TERMINAL_PROGRESS=off` turns both off,
 * `on` shows the progress in any terminal.
 */
export interface TerminalFeatures {
  links: boolean;
  progress: boolean;
}

/** The terminals that read OSC 9;4: Windows Terminal, ConEmu, WezTerm and Ghostty. */
function readsProgress(env: NodeJS.ProcessEnv): boolean {
  return (
    !!env.WT_SESSION || env.ConEmuANSI === 'ON' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty'
  );
}

export function terminalFeatures(env: NodeJS.ProcessEnv, isTerminal: boolean): TerminalFeatures {
  const setting = env[PIWI_TERMINAL_PROGRESS_ENV]?.trim().toLowerCase();
  if (!isTerminal || detectCi(env) || ['off', 'false', '0', 'no'].includes(setting ?? '')) {
    return { links: false, progress: false };
  }
  return { links: true, progress: ['on', 'true', '1', 'yes'].includes(setting ?? '') || readsProgress(env) };
}

const OSC = '\u001b]';
const ST = '\u001b\\';

/** `text` as a link to `url` (OSC 8); `text` alone for a URL that holds a control character. */
export function terminalLink(url: string, text: string = url): string {
  if (/[\u0000-\u001f\u007f]/.test(url)) return text;
  return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`;
}

/**
 * The run's progress in the terminal's tab or taskbar (OSC 9;4): the share of its tests that ended, in the error state
 * once one failed, written as either changes, and cleared as the run ends.
 */
export class TerminalProgress {
  private readonly ended = new Map<string, boolean>();
  private shown: string | null = null;

  constructor(
    private readonly total: number,
    private readonly write: (text: string) => void,
  ) {}

  /** A test ended for good (`failed`, how), counted once by its id, its latest outcome in place of an earlier one. */
  testEnded(id: string, failed: boolean): void {
    this.ended.set(id, failed);
    const failures = [...this.ended.values()].filter(Boolean).length;
    const percent = this.total > 0 ? Math.min(100, Math.floor((this.ended.size / this.total) * 100)) : 0;
    this.show(`${failures > 0 ? 2 : 1};${percent}`);
  }

  /** The run started: the bar shows at 0. */
  begin(): void {
    this.show('1;0');
  }

  /** The run ended: the bar goes. */
  end(): void {
    if (this.shown === null) return;
    this.shown = null;
    this.write(`${OSC}9;4;0;0${ST}`);
  }

  private show(state: string): void {
    if (this.shown === state) return;
    this.shown = state;
    this.write(`${OSC}9;4;${state}${ST}`);
  }
}
