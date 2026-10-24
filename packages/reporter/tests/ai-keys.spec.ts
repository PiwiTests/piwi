import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AI_DIR,
  entryDir,
  entryPath,
  findTemplateSites,
  hashTemplate,
  normalizeTemplate,
  ordinalForLocation,
  orderByPosition,
  slug,
} from '../src/internal/ai/keys.js';

describe('normalizeTemplate', () => {
  it('collapses whitespace, trims and lower-cases', () => {
    expect(normalizeTemplate('  Log   IN as  User ')).toBe('log in as user');
  });
  it('treats case- and whitespace-only variants as the same key', () => {
    expect(normalizeTemplate('The Submit Button')).toBe(normalizeTemplate('the  submit button'));
  });
});

describe('hashTemplate', () => {
  it('is stable and 8 hex chars', () => {
    const h = hashTemplate('the submit button');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(hashTemplate('the submit button')).toBe(h);
  });
  it('folds the ordinal in only when non-zero', () => {
    expect(hashTemplate('t', 0)).toBe(hashTemplate('t'));
    expect(hashTemplate('t', 1)).not.toBe(hashTemplate('t'));
  });
});

describe('slug', () => {
  it('lower-cases, hyphenates and truncates', () => {
    expect(slug('Pays by Card!')).toBe('pays-by-card');
    expect(slug('a'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
  it('never yields an empty slug', () => {
    expect(slug('!!!')).toBe('x');
  });
});

describe('entry paths', () => {
  it('lays entries out as <spec-dir>/<dir>/<spec-file>/<slug>.<slug>.<hash>.json', () => {
    expect(entryDir('/repo/tests/checkout.spec.ts')).toBe(`/repo/tests/${DEFAULT_AI_DIR}/checkout.spec.ts`);
    const file = entryPath({
      specFile: '/repo/tests/checkout.spec.ts',
      testTitle: 'pays by card',
      template: 'the submit button',
    });
    expect(file).toMatch(/\/repo\/tests\/__piwi__\/checkout\.spec\.ts\/pays-by-card\.the-submit-button\.[0-9a-f]{8}\.json$/);
  });

  it('keys per test — same template in two tests yields different files', () => {
    const a = entryPath({ specFile: '/s.ts', testTitle: 'test one', template: 'the button' });
    const b = entryPath({ specFile: '/s.ts', testTitle: 'test two', template: 'the button' });
    expect(a).not.toBe(b);
  });

  it('honors a custom directory name', () => {
    const file = entryPath({ specFile: '/s.ts', testTitle: 't', template: 'x', dir: '.ai' });
    expect(file).toContain('/.ai/');
  });
});

describe('source-position ordinals', () => {
  it('orders locations by line then column, independent of input order', () => {
    expect(orderByPosition(['f:10:5', 'f:2:9', 'f:10:1'])).toEqual(['f:2:9', 'f:10:1', 'f:10:5']);
  });

  it('assigns an ordinal by source position, not call order', () => {
    const sites = ['f:30:1', 'f:10:1', 'f:20:1'];
    // The earliest site is ordinal 0 regardless of the order sites were seen.
    expect(ordinalForLocation(sites, 'f:10:1')).toBe(0);
    expect(ordinalForLocation(sites, 'f:20:1')).toBe(1);
    expect(ordinalForLocation(sites, 'f:30:1')).toBe(2);
  });

  it('findTemplateSites reports every literal occurrence as line:col', () => {
    const source = ["page.piwiLocator('the button');", '', "  page.piwiLocator('the button');"].join('\n');
    const sites = findTemplateSites(source, 'the button');
    expect(sites).toHaveLength(2);
    expect(sites[0]).toBe('1:19');
    expect(sites[1]).toBe('3:21');
  });
});
