import { describe, expect, test } from 'vitest';
import { externalIdLink, normalizeExternalIdUrl } from '#shared/external-id-link';

describe('normalizeExternalIdUrl', () => {
  test('keeps an absolute http(s) URL holding {id}, trimmed', () => {
    expect(normalizeExternalIdUrl('  https://tcm.example.com/case/{id}  ')).toBe('https://tcm.example.com/case/{id}');
    expect(normalizeExternalIdUrl('http://tcm.local/?case={id}')).toBe('http://tcm.local/?case={id}');
  });

  test('reads blank and null as no link', () => {
    expect(normalizeExternalIdUrl('   ')).toBeNull();
    expect(normalizeExternalIdUrl(null)).toBeNull();
  });

  test('refuses a URL without {id}, another scheme or a relative path', () => {
    for (const value of ['https://tcm.example.com/case/', 'javascript:alert({id})', '/case/{id}']) {
      expect(normalizeExternalIdUrl(value), value).toBeUndefined();
    }
  });
});

describe('externalIdLink', () => {
  test('replaces every {id} with the encoded ID', () => {
    expect(externalIdLink('https://tcm.example.com/case/{id}?ref={id}', 'A B/1')).toBe(
      'https://tcm.example.com/case/A%20B%2F1?ref=A%20B%2F1',
    );
  });

  test('gives no link without a valid template', () => {
    expect(externalIdLink(null, '1')).toBeNull();
    expect(externalIdLink('javascript:{id}', '1')).toBeNull();
  });
});
