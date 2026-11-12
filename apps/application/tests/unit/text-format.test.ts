import { describe, test, expect } from 'vitest';
import { isImageFile, isVideoFile, withTypedValue } from '../../app/utils/text-format';
import { stripAnsi } from '@piwitests/run-ui/ansi';

const ESC = String.fromCharCode(27); // ANSI escape

describe('stripAnsi', () => {
  test('passes plain text through unchanged', () => {
    expect(stripAnsi('TimeoutError: locator.click')).toBe('TimeoutError: locator.click');
  });

  test('removes SGR color codes', () => {
    expect(stripAnsi(`${ESC}[31mError${ESC}[0m: boom`)).toBe('Error: boom');
  });

  test('strips codes across multiple lines, keeping the newline', () => {
    expect(stripAnsi(`${ESC}[1mline1${ESC}[0m\n${ESC}[2mline2${ESC}[0m`)).toBe('line1\nline2');
  });
});

describe('isImageFile', () => {
  test('detects by extension (case-insensitive)', () => {
    expect(isImageFile('shot.PNG')).toBe(true);
    expect(isImageFile('a/b/pic.webp')).toBe(true);
    expect(isImageFile('trace.zip')).toBe(false);
  });

  test('detects by content type when the extension is absent', () => {
    expect(isImageFile('attachment', 'image/png')).toBe(true);
    expect(isImageFile('attachment', 'application/zip')).toBe(false);
  });
});

describe('isVideoFile', () => {
  test('detects by extension (case-insensitive)', () => {
    expect(isVideoFile('run.WEBM')).toBe(true);
    expect(isVideoFile('a/b/clip.mp4')).toBe(true);
    expect(isVideoFile('shot.png')).toBe(false);
    expect(isVideoFile('trace.zip')).toBe(false);
  });

  test('detects by content type when the extension is absent', () => {
    expect(isVideoFile('attachment', 'video/webm')).toBe(true);
    expect(isVideoFile('attachment', 'image/png')).toBe(false);
  });
});

describe('withTypedValue', () => {
  test('appends the trimmed value', () => {
    expect(withTypedValue(['e2e'], '  flaky  ')).toEqual(['e2e', 'flaky']);
  });

  test('keeps the list as is for a blank or already present value', () => {
    const list = ['e2e'];
    expect(withTypedValue(list, '   ')).toBe(list);
    expect(withTypedValue(list, ' e2e ')).toBe(list);
  });
});
