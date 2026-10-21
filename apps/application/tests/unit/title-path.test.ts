import { describe, expect, it } from 'vitest';
import { foldSegments, splitFilePath, TITLE_PATH_MAX_DESCRIBES, TITLE_PATH_MAX_FOLDERS } from '~/utils/title-path';

describe('foldSegments', () => {
  it('shows a short list whole', () => {
    expect(foldSegments(['tests', 'checkout'], TITLE_PATH_MAX_FOLDERS, 2)).toEqual({
      head: ['tests', 'checkout'],
      hidden: [],
      tail: [],
    });
    expect(foldSegments(['a', 'b', 'c', 'd'], TITLE_PATH_MAX_FOLDERS, 2).hidden).toEqual([]);
    expect(foldSegments([], TITLE_PATH_MAX_DESCRIBES, 1).head).toEqual([]);
  });

  it('keeps the first two folders and the last of a deep spec file', () => {
    const folders = splitFilePath(
      'apps/storefront/e2e/specs/checkout/payment-methods/wallets/apple-pay.spec.ts',
    ).folders;
    expect(foldSegments(folders, TITLE_PATH_MAX_FOLDERS, 2)).toEqual({
      head: ['apps', 'storefront'],
      hidden: ['e2e', 'specs', 'checkout', 'payment-methods'],
      tail: ['wallets'],
    });
  });

  it('keeps the outermost and the innermost of deep describe blocks', () => {
    expect(foldSegments(['Checkout', 'Payment', 'Wallets', 'signed in'], TITLE_PATH_MAX_DESCRIBES, 1)).toEqual({
      head: ['Checkout'],
      hidden: ['Payment', 'Wallets'],
      tail: ['signed in'],
    });
  });
});

describe('splitFilePath', () => {
  it('splits the folders from the file name', () => {
    expect(splitFilePath('tests/checkout/checkout.spec.ts')).toEqual({
      folders: ['tests', 'checkout'],
      fileName: 'checkout.spec.ts',
    });
    expect(splitFilePath('home.spec.ts')).toEqual({ folders: [], fileName: 'home.spec.ts' });
  });
});
