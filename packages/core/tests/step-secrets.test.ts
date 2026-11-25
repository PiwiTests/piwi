import { describe, expect, test } from 'vitest';
import { flattenSteps, hideStepParamSecrets, hideStepTextSecrets } from '../src/step-analysis';

/** A value in a credential's shape, built from parts so no scanner reads it as a live key. */
const KEY = ['sk_live_', 'a3Z9'.repeat(8)].join('');

describe('hideStepTextSecrets', () => {
  test.each([
    ['https://user:hunter2@shop.test/login?token=s3cret', 'https://user:<hidden>@shop.test/login?token=<hidden>'],
    ['/reset?code=246810&page=2', '/reset?code=<hidden>&page=2'],
    ['https://shop.test/#access_token=abc123', 'https://shop.test/#access_token=<hidden>'],
    [`https://api.test/v1/orders?key=${KEY}`, 'https://api.test/v1/orders?key=<hidden>'],
  ])('hides the credentials of the URL %s', (url, hidden) => {
    expect(hideStepTextSecrets(url)).toBe(hidden);
  });

  test.each([['https://shop.test/cart/12?page=2'], ["getByRole('button', { name: 'Save' })"], ['/files/report.pdf']])(
    'keeps %s as it is',
    (text) => {
      expect(hideStepTextSecrets(text)).toBe(text);
    },
  );

  test('hides a credential in text around a URL', () => {
    expect(hideStepTextSecrets('open https://shop.test/?token=s3cret now')).toBe(
      'open https://shop.test/?token=<hidden> now',
    );
  });
});

describe('hideStepParamSecrets', () => {
  test('hides the url param of any step, and every text param of a step of the test’s own', () => {
    expect(
      hideStepParamSecrets({ url: '/login?token=s3cret', locator: "getByLabel('Token')", value: 'x' }, 'navigation'),
    ).toEqual({ url: '/login?token=<hidden>', locator: "getByLabel('Token')", value: 'x' });
    expect(hideStepParamSecrets({ link: '/login?token=s3cret', note: `key ${KEY}`, n: 2 }, 'test.step')).toEqual({
      link: '/login?token=<hidden>',
      note: 'key <hidden>',
      n: 2,
    });
  });
});

describe('flattenSteps', () => {
  test('hides the credentials of a navigation’s subtitle and url param', () => {
    const [step] = flattenSteps([
      {
        title: 'Navigate',
        category: 'pw:api',
        subtitle: 'https://user:hunter2@shop.test/login?token=s3cret',
        params: { url: 'https://user:hunter2@shop.test/login?token=s3cret' },
        duration: 10,
      },
    ]);
    expect(step).toMatchObject({
      subtitle: 'https://user:<hidden>@shop.test/login?token=<hidden>',
      params: { url: 'https://user:<hidden>@shop.test/login?token=<hidden>' },
    });
  });

  test('hides the credentials of a test.step’s params, its objects as JSON included', () => {
    const [step] = flattenSteps([
      {
        title: 'Log in',
        category: 'test.step',
        params: { user: 'alice', link: '/magic?token=s3cret', body: { password: 'hunter2', page: 1 } },
        duration: 10,
      },
    ]);
    expect(step!.params).toEqual({
      user: 'alice',
      link: '/magic?token=<hidden>',
      body: '{"password":"<hidden>","page":1}',
    });
  });

  test('keeps the text a call types into a field not named for a secret', () => {
    const [step] = flattenSteps([
      {
        title: 'Fill "A8F3K2L9Q1"',
        category: 'pw:api',
        params: { locator: "getByLabel('Order')", value: 'A8F3K2L9Q1' },
      },
    ]);
    expect(step!.params).toEqual({ locator: "getByLabel('Order')", value: 'A8F3K2L9Q1' });
  });
});
