import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { computed, ref } from 'vue';

/**
 * Rich copy writes HTML and plain text where the async clipboard allows it, and
 * otherwise (an instance served over plain HTTP has no `navigator.clipboard`)
 * copies the plain text through `useCopy`, which has the legacy fallback.
 */

const plainCopies: string[] = [];

beforeEach(() => {
  plainCopies.length = 0;
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('useCopy', () => ({
    copy: async (text: string) => {
      plainCopies.push(text);
    },
    copied: ref(false),
  }));
});

afterEach(() => vi.unstubAllGlobals());

const { useCopyRich } = await import('../../app/composables/useCopyRich');

describe('useCopyRich', () => {
  test('copies the plain text where there is no async clipboard', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('ClipboardItem', class {});
    await useCopyRich().copyRich('plain', '<b>rich</b>');
    expect(plainCopies).toEqual(['plain']);
  });

  test('copies the plain text when the browser refuses the rich write', async () => {
    vi.stubGlobal('navigator', { clipboard: { write: async () => Promise.reject(new Error('denied')) } });
    vi.stubGlobal('ClipboardItem', class {});
    await useCopyRich().copyRich('plain', '<b>rich</b>');
    expect(plainCopies).toEqual(['plain']);
  });

  test('writes both formats where it can', async () => {
    const written: unknown[] = [];
    vi.stubGlobal('navigator', { clipboard: { write: async (items: unknown[]) => void written.push(...items) } });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Blob>) {}
      },
    );
    const { copyRich, copied } = useCopyRich();
    await copyRich('plain', '<b>rich</b>');
    expect(plainCopies).toEqual([]);
    expect(Object.keys((written[0] as { items: Record<string, Blob> }).items)).toEqual(['text/plain', 'text/html']);
    expect(copied.value).toBe(true);
  });
});
