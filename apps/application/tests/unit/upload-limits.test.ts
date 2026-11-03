import { describe, test, expect, afterEach } from 'vitest';
import { resolveMaxSubmitBytes, resolveMaxUploadBytes } from '../../server/utils/upload-limits';
import {
  DEFAULT_MAX_SUBMIT_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_SUBMIT_MAX_BYTES,
  MIN_IMPORT_MAX_BYTES,
  MAX_IMPORT_MAX_BYTES,
  MIN_SUBMIT_MAX_BYTES,
} from '#shared/upload-limits';

afterEach(() => {
  delete process.env.PIWI_IMPORT_MAX_BYTES;
  delete process.env.PIWI_SUBMIT_MAX_BYTES;
});

describe('resolveMaxUploadBytes', () => {
  test('defaults when the variable is unset or blank', () => {
    expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    process.env.PIWI_IMPORT_MAX_BYTES = '   ';
    expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  test('honours a value a self-hoster set to match their proxy', () => {
    process.env.PIWI_IMPORT_MAX_BYTES = String(100 * 1024 * 1024);
    expect(resolveMaxUploadBytes()).toBe(100 * 1024 * 1024);
  });

  test('clamps values outside the supported range', () => {
    process.env.PIWI_IMPORT_MAX_BYTES = '1';
    expect(resolveMaxUploadBytes()).toBe(MIN_IMPORT_MAX_BYTES);

    process.env.PIWI_IMPORT_MAX_BYTES = String(9 * 1024 * 1024 * 1024);
    expect(resolveMaxUploadBytes()).toBe(MAX_IMPORT_MAX_BYTES);
  });

  test('falls back to the default rather than disabling the cap on junk', () => {
    process.env.PIWI_IMPORT_MAX_BYTES = 'unlimited';
    expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });
});

describe('resolveMaxSubmitBytes', () => {
  test('defaults to 256 MiB, takes a value in range and clamps one outside it', () => {
    expect(resolveMaxSubmitBytes()).toBe(DEFAULT_MAX_SUBMIT_BYTES);
    expect(DEFAULT_MAX_SUBMIT_BYTES).toBe(256 * 1024 * 1024);
    process.env.PIWI_SUBMIT_MAX_BYTES = String(64 * 1024 * 1024);
    expect(resolveMaxSubmitBytes()).toBe(64 * 1024 * 1024);
    process.env.PIWI_SUBMIT_MAX_BYTES = '1';
    expect(resolveMaxSubmitBytes()).toBe(MIN_SUBMIT_MAX_BYTES);
    process.env.PIWI_SUBMIT_MAX_BYTES = String(4 * 1024 * 1024 * 1024);
    expect(resolveMaxSubmitBytes()).toBe(MAX_SUBMIT_MAX_BYTES);
    process.env.PIWI_SUBMIT_MAX_BYTES = 'unlimited';
    expect(resolveMaxSubmitBytes()).toBe(DEFAULT_MAX_SUBMIT_BYTES);
  });
});
