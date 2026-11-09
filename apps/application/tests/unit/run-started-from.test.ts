import { describe, expect, it } from 'vitest';
import { runStartedFrom } from '#shared/run-started-from';

describe('where a run started, as its header says it', () => {
  it('names the origin, and the editor that steers it when the run names one', () => {
    expect(runStartedFrom({ ci: { provider: 'github' } })).toBe('CI');
    expect(runStartedFrom({ piwiOrigin: { kind: 'local' } })).toBe('a developer’s machine');
    expect(
      runStartedFrom({
        piwiOrigin: { kind: 'local' },
        piwiInteractive: { client: 'Visual Studio Code', ref: 'terminal-12-34' },
      }),
    ).toBe('a developer’s machine, steered in Visual Studio Code');
    expect(
      runStartedFrom({
        piwiOrigin: { kind: 'editor', ref: 'ed-1' },
        piwiInteractive: { client: 'Cursor', ref: 'ed-1' },
      }),
    ).toBe('Cursor');
    expect(runStartedFrom({ piwiOrigin: { kind: 'editor' }, piwiInteractive: { client: 'editor', ref: 'ed-1' } })).toBe(
      'an editor',
    );
    expect(
      runStartedFrom({ piwiOrigin: { kind: 'desktop' }, piwiInteractive: { client: 'desktop', ref: 'desktop-3' } }),
    ).toBe('the desktop app');
    expect(runStartedFrom({ piwiOrigin: { kind: 'bisect' } })).toBe('a bisect');
  });

  it('says nothing of an origin it does not know', () => {
    expect(runStartedFrom({ piwiOrigin: { kind: 'teleport' } })).toBeNull();
  });
});
