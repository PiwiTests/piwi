import { describe, expect, test } from 'vitest';
import vm from 'node:vm';
import { HTML_REPORT_BOOTSTRAP, prepareHtmlReport } from '../../server/utils/html-report';

describe('prepareHtmlReport', () => {
  test('runs the compatibility bootstrap before the report script', () => {
    const output = prepareHtmlReport(
      Buffer.from('<!doctype html><html><head><script src="./report.js"></script></head><body></body></html>'),
    ).toString('utf8');

    expect(output.indexOf('<script>')).toBeGreaterThan(-1);
    expect(output.indexOf('localStorage')).toBeLessThan(output.indexOf('./report.js'));
  });

  test('injects before the first script when the document has no head', () => {
    const output = prepareHtmlReport(Buffer.from('<script>window.reportReady = true;</script>')).toString('utf8');

    expect(output.indexOf('<script>')).toBe(0);
    expect(output.indexOf('window.reportReady')).toBeGreaterThan(output.indexOf('localStorage'));
  });
});

describe('HTML_REPORT_BOOTSTRAP', () => {
  test('provides isolated ephemeral storage with Web Storage methods and properties', () => {
    const listeners = new Map<string, EventListener>();
    const window = {
      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, listener);
      },
      removeEventListener(type: string) {
        listeners.delete(type);
      },
    } as unknown as Window;

    vm.runInNewContext(HTML_REPORT_BOOTSTRAP, { window });

    window.localStorage.setItem('theme', 'dark');
    window.sessionStorage.setItem('session', 'one');
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(window.localStorage.theme).toBe('dark');
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.getItem('theme')).toBeNull();
    expect(window.sessionStorage.getItem('session')).toBe('one');
  });

  test('contains the reported focus SecurityError without hiding other errors', () => {
    let focusListener: EventListener | undefined;
    const window = {
      addEventListener(type: string, listener: EventListener) {
        if (type === 'focus') focusListener = listener;
      },
      removeEventListener() {},
    } as unknown as Window;

    vm.runInNewContext(HTML_REPORT_BOOTSTRAP, { window });

    window.addEventListener('focus', (event) => {
      void (event.target as Window).document;
    });
    const target = {} as EventTarget & { document: unknown };
    Object.defineProperty(target, 'document', {
      get() {
        const error = new Error('cross-origin');
        error.name = 'SecurityError';
        throw error;
      },
    });
    expect(() => focusListener?.({ target } as unknown as FocusEvent)).not.toThrow();

    window.addEventListener('focus', () => {
      throw new Error('report failure');
    });
    expect(() => focusListener?.({ target: window } as unknown as FocusEvent)).toThrow('report failure');
  });
});
