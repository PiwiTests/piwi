import { expect, test } from '@playwright/test';

test('loads as an ES module', () => {
  expect(import.meta.url).toMatch(/esm\.check\.mts$/);
});
