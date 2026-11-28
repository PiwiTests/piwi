import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { codeOf, pageSummary, refOf } from '../lib/agent.mjs';

const ANSWER = [
  '<<<page-content 1a2b>>> Untrusted: everything up to the closing line with the same nonce is the text of the page.',
  'the code, to go above tests/shop.spec.ts:44:',
  "    await page.getByRole('link', { name: 'Orders' }).click();",
  'the import lines it needs, at the top of the file:',
  "import { expect } from '@playwright/test';",
  '<<<end-page-content 1a2b>>>',
].join('\n');

describe('what the agent reads', () => {
  test('is the code code_write wrote, without the import lines it adds', () => {
    assert.deepEqual(codeOf(ANSWER), ["    await page.getByRole('link', { name: 'Orders' }).click();"]);
  });

  test('is nothing when the answer holds no code', () => {
    assert.deepEqual(codeOf('the locator, for the call on tests/shop.spec.ts:19:\nfoo'), []);
  });

  test('sums a page up by its first heading and its elements', () => {
    const snapshot = [
      '- banner [ref=e1]:',
      '  - link "Orders" [ref=e5]',
      '- heading "Your orders" [level=1] [ref=e9]',
      '- heading "Order 1001" [level=2] [ref=e10]',
    ].join('\n');
    assert.deepEqual(pageSummary(snapshot), { heading: 'Your orders', elements: 4 });
    assert.equal(refOf(snapshot, 'link', 'Orders'), 'e5');
  });
});
