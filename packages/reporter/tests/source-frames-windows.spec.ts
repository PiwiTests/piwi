import { describe, it, expect, vi } from 'vitest';
import type * as NodePath from 'node:path';
import type * as NodeFs from 'node:fs';

// A run on Windows: `node:path` names files as Windows does, and every source file reads the same lines.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof NodePath>('node:path');
  return { ...actual.win32, default: actual.win32 };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  const source = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const readFileSync = () => source;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

import { collectSourceFrames } from '../src/internal/support/source-snippet.js';

describe('the source frames of a failure on Windows', () => {
  it('names each file relative to the config folder with POSIX separators, as the test file is named', () => {
    const error = [
      'Error: boom',
      '    at addToCart (C:\\repo\\e2e\\tests\\helpers\\cart.ts:15:10)',
      '    at C:\\repo\\e2e\\tests\\checkout.spec.ts:42:5',
    ].join('\n');
    const frames = collectSourceFrames(error, 'C:\\repo\\e2e\\tests\\checkout.spec.ts', 40, {
      projectRoot: 'C:\\repo\\e2e',
      context: 1,
    });
    expect(frames.map((f) => `${f.file}:${f.line}`)).toEqual(['tests/helpers/cart.ts:15', 'tests/checkout.spec.ts:42']);
  });
});
