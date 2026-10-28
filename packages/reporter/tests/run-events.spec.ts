import { describe, it, expect } from 'vitest';
import { callPlace } from '../src/internal/capture/run-events.js';

describe('callPlace', () => {
  it('reads a POSIX file URL relative to the working directory', () => {
    expect(
      callPlace([{ file: 'file:///work/app/tests/cart.spec.ts', line: 4, column: 9 }], '/work/app', false),
    ).toEqual({
      file: 'tests/cart.spec.ts',
      line: 4,
      column: 9,
    });
  });

  it('reads a Windows file URL with forward slashes', () => {
    expect(callPlace([{ file: 'file:///C:/work/app/tests/cart.spec.ts', line: 4 }], 'C:\\work\\app', true)).toEqual({
      file: 'tests/cart.spec.ts',
      line: 4,
    });
  });

  it('decodes a percent-encoded file URL', () => {
    const frames = [{ file: 'file:///work/my%20app/tests/caf%C3%A9.spec.ts', line: 4 }];
    expect(callPlace(frames, '/work/my app', false)).toEqual({ file: 'tests/café.spec.ts', line: 4 });
  });

  it('reads a plain path', () => {
    expect(callPlace([{ file: '/work/app/tests/cart.spec.ts', line: 4 }], '/work/app', false)).toEqual({
      file: 'tests/cart.spec.ts',
      line: 4,
    });
    expect(callPlace([{ file: 'C:\\work\\app\\tests\\cart.spec.ts', line: 4 }], 'C:\\work\\app', true)).toEqual({
      file: 'tests/cart.spec.ts',
      line: 4,
    });
  });

  it('skips the frames outside the working directory and in packages', () => {
    const posix = [
      { file: 'file:///work/app/node_modules/playwright-core/lib/client/page.js', line: 1 },
      { file: 'file:///work/shared/steps.ts', line: 2 },
      { file: 'file:///work/app/tests/cart.spec.ts', line: 3 },
    ];
    expect(callPlace(posix, '/work/app', false)).toEqual({ file: 'tests/cart.spec.ts', line: 3 });
    expect(callPlace([{ file: 'file:///D:/shared/steps.ts', line: 2 }], 'C:\\work\\app', true)).toBeNull();
  });
});
