import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ARTIFACT_VERSION,
  parseEntry,
  readEntry,
  serializeEntry,
  writeEntry,
  withEntryLock,
  type LocatorEntry,
  type RunEntry,
} from '../src/internal/ai/artifact.js';

const locatorEntry: LocatorEntry = {
  version: ARTIFACT_VERSION,
  kind: 'locator',
  template: 'the submit button',
  locator: { method: 'getByRole', args: ['button', { name: 'Submit' }] },
  fingerprint: { role: 'button', name: 'Submit' },
};

const runEntry: RunEntry = {
  version: ARTIFACT_VERSION,
  kind: 'run',
  template: 'log in as {email}',
  steps: [
    { locator: { method: 'getByLabel', args: ['Email'] }, action: 'fill', value: '{{email}}' },
    { locator: { method: 'getByRole', args: ['button', { name: 'Sign in' }] }, action: 'click', waitForResponse: '**/api/login' },
  ],
  postcondition: { assert: 'visible', locator: { method: 'getByRole', args: ['heading', { name: 'Dashboard' }] } },
};

describe('canonical serialization', () => {
  it('sorts object keys deeply and ends with a single trailing newline', () => {
    const text = serializeEntry(locatorEntry);
    expect(text.endsWith('}\n')).toBe(true);
    // Top-level keys appear in sorted order regardless of construction order.
    const keyOrder = [...text.matchAll(/^ {2}"(\w+)":/gm)].map((m) => m[1]);
    expect(keyOrder).toEqual([...keyOrder].sort());
  });

  it('produces identical bytes for logically identical content built in a different order', () => {
    const reordered: LocatorEntry = {
      fingerprint: { name: 'Submit', role: 'button' },
      locator: { args: ['button', { name: 'Submit' }], method: 'getByRole' },
      template: 'the submit button',
      kind: 'locator',
      version: ARTIFACT_VERSION,
    } as LocatorEntry;
    expect(serializeEntry(reordered)).toBe(serializeEntry(locatorEntry));
  });

  it('preserves array order (steps and args are meaningful)', () => {
    const text = serializeEntry(runEntry);
    expect(text.indexOf('Email')).toBeLessThan(text.indexOf('Sign in'));
  });

  it('round-trips through parseEntry', () => {
    expect(parseEntry(serializeEntry(runEntry))).toEqual(runEntry);
  });
});

describe('allowlist validation', () => {
  it('rejects a locator method outside the allowlist', () => {
    const bad = serializeEntry(locatorEntry).replace('getByRole', 'evaluate');
    expect(() => parseEntry(bad)).toThrow(/not allowlisted/);
  });

  it('rejects an action outside the allowlist', () => {
    const bad = serializeEntry(runEntry).replace('"click"', '"goto"');
    expect(() => parseEntry(bad)).toThrow(/not allowlisted/);
  });

  it('rejects an unknown kind and an unsupported version', () => {
    expect(() => parseEntry(JSON.stringify({ version: 1, kind: 'script', template: 'x' }))).toThrow(/kind/);
    expect(() => parseEntry(JSON.stringify({ version: 99, kind: 'locator', template: 'x' }))).toThrow(/version/);
  });

  it('rejects a postcondition with an unsupported assert', () => {
    const bad = serializeEntry(runEntry).replace('"visible"', '"exists"');
    expect(() => parseEntry(bad)).toThrow(/assert/);
  });

  it('rejects a non-string waitForResponse', () => {
    const bad = JSON.stringify({
      version: ARTIFACT_VERSION,
      kind: 'run',
      template: 't',
      steps: [{ locator: { method: 'getByRole', args: [] }, action: 'click', waitForResponse: 5 }],
      postcondition: { assert: 'visible', locator: { method: 'getByRole', args: [] } },
    });
    expect(() => parseEntry(bad)).toThrow(/waitForResponse/);
  });
});

describe('reader / writer', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-ai-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readEntry returns null for a missing file', () => {
    expect(readEntry(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('writes canonical bytes atomically and creates parent directories', () => {
    const file = path.join(dir, 'nested', 'entry.json');
    const result = writeEntry(file, locatorEntry);
    expect(result.written).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(serializeEntry(locatorEntry));
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('is idempotent — a semantically equal rewrite does not touch the file', () => {
    const file = path.join(dir, 'entry.json');
    writeEntry(file, locatorEntry);
    const before = fs.statSync(file).mtimeMs;
    const second = writeEntry(file, { ...locatorEntry });
    expect(second.written).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('withEntryLock releases the lock even when the body throws', () => {
    const file = path.join(dir, 'entry.json');
    expect(() =>
      withEntryLock(file, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});
