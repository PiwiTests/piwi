import { describe, expect, it } from 'vitest';
import { isInstancePage } from '../../src/shared/instance-links.js';

describe('isInstancePage', () => {
  it('covers every page of an instance at the root of its origin', () => {
    expect(isInstancePage('https://piwi.example', 'https://piwi.example/')).toBe(true);
    expect(isInstancePage('https://piwi.example/', 'https://piwi.example/projects/3/test-functions?x=1')).toBe(true);
    expect(isInstancePage(' http://localhost:3000 ', 'http://localhost:3000/bug-reports')).toBe(true);
  });

  it('leaves out another port of the same host, as an app under test on localhost', () => {
    expect(isInstancePage('http://localhost:3000', 'http://localhost:5173/')).toBe(false);
    expect(isInstancePage('http://localhost:3000', 'https://localhost:3000/')).toBe(false);
    expect(isInstancePage('https://piwi.example', 'https://shop.piwi.example/')).toBe(false);
  });

  it('keeps an instance under a path to that path', () => {
    expect(isInstancePage('https://tools.example/piwi', 'https://tools.example/piwi')).toBe(true);
    expect(isInstancePage('https://tools.example/piwi/', 'https://tools.example/piwi/projects')).toBe(true);
    expect(isInstancePage('https://tools.example/piwi', 'https://tools.example/piwi-old/')).toBe(false);
    expect(isInstancePage('https://tools.example/piwi', 'https://tools.example/')).toBe(false);
  });

  it('marks nothing without a connection or on a page that is not http', () => {
    expect(isInstancePage('', 'https://piwi.example/')).toBe(false);
    expect(isInstancePage('not a url', 'https://piwi.example/')).toBe(false);
    expect(isInstancePage('file:///tmp/piwi', 'file:///tmp/piwi/index.html')).toBe(false);
    expect(isInstancePage('https://piwi.example', 'about:blank')).toBe(false);
  });
});
