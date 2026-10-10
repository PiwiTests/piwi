import { describe, expect, it } from 'vitest';
import { PICKER_CHROME_URL, PICKER_FIREFOX_URL, pickerStoreFor } from '#shared/companion-links';

const UA = {
  chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  iPad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
};

describe('pickerStoreFor', () => {
  it('sends Chrome and Edge to the Chrome Web Store', () => {
    expect(pickerStoreFor(UA.chrome)).toEqual({ name: 'Chrome Web Store', url: PICKER_CHROME_URL });
    expect(pickerStoreFor(UA.edge)).toEqual({ name: 'Chrome Web Store', url: PICKER_CHROME_URL });
  });

  it('sends Firefox to Firefox Add-ons', () => {
    expect(pickerStoreFor(UA.firefox)).toEqual({ name: 'Firefox Add-ons', url: PICKER_FIREFOX_URL });
  });

  it('has no store for Safari or a phone or tablet browser', () => {
    expect(pickerStoreFor(UA.safari)).toBeNull();
    expect(pickerStoreFor(UA.androidChrome)).toBeNull();
    expect(pickerStoreFor(UA.androidFirefox)).toBeNull();
    expect(pickerStoreFor(UA.iPad)).toBeNull();
    expect(pickerStoreFor('')).toBeNull();
  });
});
