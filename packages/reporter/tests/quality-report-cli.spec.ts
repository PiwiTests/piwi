import { describe, it, expect } from 'vitest';
import { failsOn, normalizePeriod, parseReportArgs, reportQuery } from '../src/cli/quality-report.js';

const env = { PIWI_DASHBOARD_URL: 'https://dash.example/', PIWI_API_KEY: 'k' };

describe('parseReportArgs', () => {
  it('defaults to the executive report as Markdown over the last 30 days', () => {
    const args = parseReportArgs([], env);
    expect(args).toMatchObject({
      serverUrl: 'https://dash.example',
      apiKey: 'k',
      dashboard: 'executive',
      format: 'md',
      period: 'last-30d',
      projects: [],
      failOn: null,
    });
  });

  it('reads the scope, the format and the output', () => {
    const args = parseReportArgs(
      ['--project', 'checkout,7', '--period', '7d', '--format', 'pdf', '--output', 'r.pdf', '--lang', 'fr', '--branch=main'],
      env,
    );
    expect(args).toMatchObject({ projects: ['checkout', '7'], period: 'last-7d', format: 'pdf', output: 'r.pdf', lang: 'fr', branches: 'main' });
  });

  it('refuses what it cannot send', () => {
    expect(() => parseReportArgs([], {})).toThrow(/dashboard URL/);
    expect(() => parseReportArgs(['--format', 'docx'], env)).toThrow(/--format/);
    expect(() => parseReportArgs(['--dashboard', 'team'], env)).toThrow(/--dashboard/);
    expect(() => parseReportArgs(['--format', 'pdf'], env)).toThrow(/--output/);
    expect(() => parseReportArgs(['--fail-on', 'good'], env)).toThrow(/--fail-on/);
    expect(() => parseReportArgs(['--lang', 'not a code'], env)).toThrow(/--lang/);
  });

  it('sends any language code, and the dashboard says which it writes', () => {
    expect(parseReportArgs(['--lang', 'de'], env).lang).toBe('de');
    expect(parseReportArgs(['--lang', 'pt-BR'], env).lang).toBe('pt-BR');
  });
});

describe('reportQuery', () => {
  it('maps the arguments to the preview endpoint keys', () => {
    const args = parseReportArgs(['--period', 'last-month', '--selection', 'smoke', '--compare', 'year'], env);
    expect(Object.fromEntries(reportQuery(args, [3, 4], 'json'))).toEqual({
      dashboard: 'executive',
      format: 'json',
      period: 'last-month',
      projects: '3,4',
      compare: 'year',
      sel: 'smoke',
    });
  });
});

describe('normalizePeriod and failsOn', () => {
  it('expands day shorthands only', () => {
    expect(normalizePeriod('90d')).toBe('last-90d');
    expect(normalizePeriod('this-quarter')).toBe('this-quarter');
  });

  it('fails on bad, or on mixed and bad', () => {
    expect(failsOn('bad', 'bad')).toBe(true);
    expect(failsOn('mixed', 'bad')).toBe(false);
    expect(failsOn('mixed', 'mixed')).toBe(true);
    expect(failsOn('good', 'mixed')).toBe(false);
    expect(failsOn('bad', null)).toBe(false);
  });
});
