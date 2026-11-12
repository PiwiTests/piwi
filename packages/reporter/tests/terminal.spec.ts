import { describe, expect, it } from 'vitest';
import { TerminalProgress, terminalFeatures, terminalLink } from '../src/internal/support/terminal.js';

/**
 * What a run's terminal shows besides its lines: the run's page as a link and the run's progress in the terminal's tab
 * or taskbar, outside CI and in a terminal alone, the progress only where the terminal reads it, both turned off by
 * `PIWI_TERMINAL_PROGRESS=off`.
 */

describe('terminalFeatures', () => {
  it('links in any terminal outside CI, and shows progress in the terminals that read it', () => {
    expect(terminalFeatures({}, true)).toEqual({ links: true, progress: false });
    expect(terminalFeatures({ WT_SESSION: 'x' }, true)).toEqual({ links: true, progress: true });
    expect(terminalFeatures({ TERM_PROGRAM: 'ghostty' }, true)).toEqual({ links: true, progress: true });
    expect(terminalFeatures({ TERM_PROGRAM: 'WezTerm' }, true)).toEqual({ links: true, progress: false });
    expect(terminalFeatures({ ConEmuANSI: 'ON' }, true)).toEqual({ links: true, progress: true });
    expect(terminalFeatures({ TERM_PROGRAM: 'iTerm.app' }, true)).toEqual({ links: true, progress: false });
  });

  it('shows nothing in CI, to a file or a pipe, or with PIWI_TERMINAL_PROGRESS=off; on shows progress anywhere', () => {
    const none = { links: false, progress: false };
    expect(terminalFeatures({ WT_SESSION: 'x', CI: 'true' }, true)).toEqual(none);
    expect(terminalFeatures({ WT_SESSION: 'x' }, false)).toEqual(none);
    expect(terminalFeatures({ WT_SESSION: 'x', TERM: 'dumb' }, true)).toEqual(none);
    expect(terminalFeatures({ WT_SESSION: 'x', PIWI_TERMINAL_PROGRESS: 'off' }, true)).toEqual(none);
    expect(terminalFeatures({ PIWI_TERMINAL_PROGRESS: 'ON' }, true)).toEqual({ links: true, progress: true });
    expect(terminalFeatures({ PIWI_TERMINAL_PROGRESS: 'on' }, false)).toEqual(none);
  });
});

describe('terminalLink', () => {
  it('wraps the text in an OSC 8 link, and shows a URL or a text with a control character as text without them', () => {
    expect(terminalLink('https://dash.example.com/test-runs/42')).toBe(
      '\u001b]8;;https://dash.example.com/test-runs/42\u001b\\https://dash.example.com/test-runs/42\u001b]8;;\u001b\\',
    );
    expect(terminalLink('https://x\u001b]8;;evil', 'run')).toBe('run');
    expect(terminalLink('https://x/1\u001b]0;title\u0007')).toBe('https://x/1]0;title');
    expect(terminalLink('https://x/1\u009b2J')).toBe('https://x/12J');
  });
});

describe('TerminalProgress', () => {
  it('shows the share of tests that ended, red once one failed, each test once, and clears as the run ends', () => {
    const written: string[] = [];
    const progress = new TerminalProgress(4, (text) => written.push(text));
    progress.begin();
    progress.testEnded('a', false);
    progress.testEnded('a', false);
    progress.testEnded('b', true);
    // A test counted again with its latest outcome takes the place of the earlier one.
    progress.testEnded('b', false);
    progress.testEnded('c', false);
    progress.testEnded('d', false);
    progress.end();
    progress.end();
    expect(written).toEqual([
      '\u001b]9;4;1;0\u001b\\',
      '\u001b]9;4;1;25\u001b\\',
      '\u001b]9;4;2;50\u001b\\',
      '\u001b]9;4;1;50\u001b\\',
      '\u001b]9;4;1;75\u001b\\',
      '\u001b]9;4;1;100\u001b\\',
      '\u001b]9;4;0;0\u001b\\',
    ]);
  });

  it('keeps the failures counted as a test’s latest outcome replaces its earlier one', () => {
    const written: string[] = [];
    const progress = new TerminalProgress(10, (text) => written.push(text));
    progress.testEnded('a', true);
    progress.testEnded('a', true);
    progress.testEnded('b', true);
    progress.testEnded('a', false);
    progress.testEnded('b', false);
    expect(written[written.length - 1]).toBe('\u001b]9;4;1;20\u001b\\');
  });

  it('clears through the writer the process’s end gives', () => {
    const written: string[] = [];
    const atExit: string[] = [];
    const progress = new TerminalProgress(2, (text) => written.push(text));
    progress.begin();
    progress.end((text) => atExit.push(text));
    progress.end((text) => atExit.push(text));
    expect(atExit).toEqual(['\u001b]9;4;0;0\u001b\\']);
  });

  it('shows 0 for a run with no planned test', () => {
    const written: string[] = [];
    const progress = new TerminalProgress(0, (text) => written.push(text));
    progress.testEnded('a', false);
    expect(written).toEqual(['\u001b]9;4;1;0\u001b\\']);
  });
});
