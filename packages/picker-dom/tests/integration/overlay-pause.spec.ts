import { test, expect } from '@playwright/test';
import { pauseAnswered, showPauseBar, takePauseState, type PauseBarArg } from '../../src/overlay-pause.js';

const ARG: PauseBarArg = {
  place: 'login.spec.ts:42',
  attempt: 2,
  action: 'click',
  locator: "getByRole('button', { name: 'Pay' })",
};

test.describe('showPauseBar', () => {
  test('says where the test is paused and answers each button', async ({ page }) => {
    await page.setContent('<!doctype html><html><body><button>Pay</button></body></html>');
    for (const [label, choice] of [
      ['Resume', 'resume'],
      ['Step', 'step'],
      ['Pick a locator', 'pick'],
      ['Finish', 'finish'],
    ] as const) {
      await page.evaluate(showPauseBar, ARG);
      const bar = page.getByRole('toolbar', { name: 'Piwi: test paused' });
      await expect(bar).toContainText('Paused at login.spec.ts:42 · attempt 2');
      await expect(bar).toContainText("click · getByRole('button', { name: 'Pay' })");
      expect(await page.evaluate(pauseAnswered)).toBe(false);
      await bar.getByRole('button', { name: label, exact: true }).click();
      expect(await page.evaluate(pauseAnswered)).toBe(true);
      expect(await page.evaluate(takePauseState)).toBe(choice);
      await expect(bar).toHaveCount(0);
    }
  });

  test('offers Record here only when the editor can record from the pause', async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(showPauseBar, ARG);
    const bar = page.getByRole('toolbar', { name: 'Piwi: test paused' });
    await expect(bar.getByRole('button')).toHaveText(['Resume', 'Step', 'Pick a locator', 'Finish']);
    await page.evaluate(takePauseState);
    await page.evaluate(showPauseBar, { ...ARG, record: true });
    await expect(bar.getByRole('button')).toHaveText(['Resume', 'Step', 'Pick a locator', 'Record here', 'Finish']);
    await bar.getByRole('button', { name: 'Record here' }).click();
    expect(await page.evaluate(takePauseState)).toBe('record');
  });

  test('resumes on Escape, and leaves the attempt out of the first one', async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(showPauseBar, { ...ARG, attempt: null, locator: null });
    const bar = page.getByRole('toolbar', { name: 'Piwi: test paused' });
    await expect(bar).toHaveText(/^Paused at login\.spec\.ts:42click/);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(takePauseState)).toBe('resume');
  });

  test('counts as answered once the page navigated away, with no answer to take', async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(showPauseBar, ARG);
    await page.setContent('<!doctype html><html><body><p>Next page</p></body></html>');
    expect(await page.evaluate(pauseAnswered)).toBe(true);
    expect(await page.evaluate(takePauseState)).toBeNull();
  });
});
