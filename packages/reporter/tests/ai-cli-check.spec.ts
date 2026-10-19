import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkAiTree } from '../src/internal/ai/check.js';
import { serializeEntry, type LocatorEntry } from '../src/internal/ai/artifact.js';
import { entryPath } from '../src/internal/ai/keys.js';
import { buildResolveInvocation, runAi, runCheck } from '../src/cli/ai.js';

function locatorEntry(template: string): LocatorEntry {
  return {
    version: 1,
    kind: 'locator',
    template,
    locator: { method: 'getByRole', args: ['button', { name: 'Go' }] },
    fingerprint: { role: 'button', name: 'Go' },
  };
}

describe('checkAiTree', () => {
  let root: string;
  let specFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-ai-check-'));
    specFile = path.join(root, 'login.spec.ts');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeEntryFile(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  it('reports nothing for a clean, canonical tree whose templates are live', () => {
    fs.writeFileSync(specFile, "page.piwiLocator('the submit button');");
    const file = entryPath({ specFile, testTitle: 'logs in', template: 'the submit button' });
    writeEntryFile(file, serializeEntry(locatorEntry('the submit button')));
    expect(checkAiTree(root)).toEqual([]);
  });

  it('flags non-canonical, orphaned, invalid and duplicate-template entries', () => {
    fs.writeFileSync(
      specFile,
      ["page.piwiLocator('the submit button');", "page.piwiLocator('the email field');"].join('\n'),
    );

    // Non-canonical: valid content, but minified bytes.
    const nonCanonical = entryPath({ specFile, testTitle: 'logs in', template: 'the submit button' });
    writeEntryFile(nonCanonical, JSON.stringify(locatorEntry('the submit button')));

    // Orphan: template no longer present in the source.
    const orphan = entryPath({ specFile, testTitle: 'logs in', template: 'a removed prompt' });
    writeEntryFile(orphan, serializeEntry(locatorEntry('a removed prompt')));

    // Invalid: not a valid entry.
    writeEntryFile(path.join(path.dirname(orphan), 'logs-in.broken.deadbeef.json'), '{ not json');

    // Duplicate template within one test (two ordinals).
    const dupA = entryPath({ specFile, testTitle: 'logs in', template: 'the email field', ordinal: 0 });
    const dupB = entryPath({ specFile, testTitle: 'logs in', template: 'the email field', ordinal: 1 });
    writeEntryFile(dupA, serializeEntry(locatorEntry('the email field')));
    writeEntryFile(dupB, serializeEntry(locatorEntry('the email field')));

    const findings = checkAiTree(root);
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toContain('non-canonical');
    expect(kinds).toContain('orphan');
    expect(kinds).toContain('invalid');
    expect(findings.filter((f) => f.kind === 'duplicate-template')).toHaveLength(2);
    expect(findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('names a command that rewrites a non-canonical entry, never the unavailable prune', async () => {
    fs.writeFileSync(specFile, "page.piwiLocator('the submit button');");
    const file = entryPath({ specFile, testTitle: 'logs in', template: 'the submit button' });
    writeEntryFile(file, JSON.stringify(locatorEntry('the submit button')));

    const [finding] = checkAiTree(root);
    expect(finding!.kind).toBe('non-canonical');
    expect(finding!.message).toContain('`piwi ai resolve --update-ai`');
    expect(finding!.message).not.toContain('prune');

    // The prune stub points to the same commands.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runAi(['prune'], {})).toBe(2);
    expect(error.mock.calls.flat().join(' ')).toContain('piwi ai resolve --update-ai');
    error.mockRestore();
  });
});

describe('runCheck / runAi', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-ai-cli-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exits 0 on a clean tree', () => {
    expect(runCheck([`--cwd=${root}`], {})).toBe(0);
  });

  it('exits 1 when hygiene issues are found', () => {
    const specFile = path.join(root, 's.spec.ts');
    fs.writeFileSync(specFile, '// no prompts here');
    const orphan = entryPath({ specFile, testTitle: 't', template: 'a removed prompt' });
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, serializeEntry(locatorEntry('a removed prompt')));
    expect(runCheck([`--cwd=${root}`], {})).toBe(1);
  });

  it('help exits 0 and an unknown subcommand exits 2', async () => {
    expect(await runAi(['--help'], {})).toBe(0);
    expect(await runAi(['bogus'], {})).toBe(2);
  });

  it('resolve refuses to run without an authoring server configured', async () => {
    expect(await runAi(['resolve'], {})).toBe(2);
  });
});

describe('buildResolveInvocation', () => {
  it('runs playwright test in resolve mode, single-worker, threading grep/project/env', () => {
    const inv = buildResolveInvocation(
      ['--grep', 'checkout', '--project', 'chromium', '--update-ai', '--env', 'FLAG=on'],
      { PIWI_DASHBOARD_URL: 'https://d', PATH: '/usr/bin' },
    );
    expect(inv.args).toEqual(['--grep', 'checkout', '--project', 'chromium', '--workers=1']);
    expect(inv.env.PIWI_AI).toBe('resolve');
    expect(inv.env.PIWI_AI_UPDATE).toBe('true');
    expect(inv.env.FLAG).toBe('on');
    expect(inv.env.PIWI_DASHBOARD_URL).toBe('https://d');
  });

  it('omits the update flag when --update-ai is absent', () => {
    const inv = buildResolveInvocation([], {});
    expect(inv.args).toEqual(['--workers=1']);
    expect(inv.env.PIWI_AI_UPDATE).toBeUndefined();
  });
});
