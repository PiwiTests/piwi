import { describe, it, expect, vi } from 'vitest';
import {
  FailureLinks,
  caseLocateUrl,
  failureHeadline,
  formatFailureLine,
} from '../src/internal/support/failure-links.js';
import { Logger } from '../src/internal/support/logger.js';

const TEST = {
  title: 'applies the discount',
  file: 'tests/checkout.spec.ts',
  retry: 2,
  browser: 'chromium',
  headline: null,
};

describe('caseLocateUrl', () => {
  it('builds the resolver URL from the run id and the test identity', () => {
    expect(caseLocateUrl('https://dash.example.com/', 42, TEST)).toBe(
      'https://dash.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=applies%20the%20discount&retry=2&browser=chromium',
    );
  });

  it('omits the browser when the test ran under no project', () => {
    expect(caseLocateUrl('https://dash.example.com', 42, { ...TEST, browser: null })).toBe(
      'https://dash.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=applies%20the%20discount&retry=2',
    );
  });

  it('names the `--repeat-each` repetition past the first', () => {
    expect(caseLocateUrl('https://dash.example.com', 42, { ...TEST, repeatEachIndex: 3 })).toBe(
      'https://dash.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=applies%20the%20discount&retry=2&browser=chromium&repeat=3',
    );
    expect(caseLocateUrl('https://dash.example.com', 42, { ...TEST, repeatEachIndex: 0 })).not.toContain('repeat=');
  });

  it('encodes characters a title may carry', () => {
    const url = caseLocateUrl('https://dash.example.com', 1, { ...TEST, title: 'a+b & c=d #1' });
    expect(url).toContain('title=a%2Bb%20%26%20c%3Dd%20%231');
  });
});

describe('failureHeadline', () => {
  it('explains the error in one line, naming the failed step on a test timeout', () => {
    expect(
      failureHeadline(
        "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n",
      ),
    ).toBe("getByRole('button', { name: 'Pay' }) was not found on the page — click timed out after 30 s");
    expect(
      failureHeadline('Test timeout of 30000ms exceeded.', [
        { title: "page.goto('/checkout')" },
        { title: 'fillPaymentDetails(page)', failed: true },
      ]),
    ).toBe('Test timed out after 30 s while "fillPaymentDetails(page)"');
    expect(failureHeadline(null)).toBeNull();
  });
});

describe('formatFailureLine', () => {
  it('puts the headline between the title and the link, and omits it when there is none', () => {
    const url = 'https://dash.example.com/test-runs/1/locate?file=a';
    expect(formatFailureLine({ ...TEST, url, headline: 'Navigation to /users timed out after 30 s' })).toBe(
      `✗ applies the discount — Navigation to /users timed out after 30 s → ${url}`,
    );
    expect(formatFailureLine({ ...TEST, url })).toBe(`✗ applies the discount → ${url}`);
  });
});

describe('FailureLinks', () => {
  it('prints one line per failure, each only once', () => {
    const logger = new Logger(false);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const links = new FailureLinks('https://dash.example.com', logger);

    links.add(TEST);
    links.add({ ...TEST, title: 'second' });
    links.printPending(7);
    links.printPending(7);
    links.add({ ...TEST, title: 'third' });
    links.printPending(7);

    expect(info.mock.calls.map((c) => c[0])).toEqual([
      formatFailureLine({ ...TEST, url: caseLocateUrl('https://dash.example.com', 7, TEST) }),
      `✗ second → ${caseLocateUrl('https://dash.example.com', 7, { ...TEST, title: 'second' })}`,
      `✗ third → ${caseLocateUrl('https://dash.example.com', 7, { ...TEST, title: 'third' })}`,
    ]);
    expect(links.count).toBe(3);
  });

  it('resolves every failure against the run id it is given', () => {
    const links = new FailureLinks('https://dash.example.com', new Logger(false));
    links.add(TEST);
    expect(links.resolve(9)).toEqual([{ ...TEST, url: caseLocateUrl('https://dash.example.com', 9, TEST) }]);
  });
});
