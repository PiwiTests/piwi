import type { ReportBundle } from '../../shared/reports/types';

/** A bundle with one of every block, and run-derived text that tries to break each format. */
export const HOSTILE = '=1+1 | <script>alert(1)</script> *x* [a](b) # h';

export function fixtureBundle(): ReportBundle {
  return {
    generatedAt: '2026-09-25T08:00:00.000Z',
    piwiVersion: '0.38.0',
    sourceUrl: 'https://piwi.example/analytics?period=last-30d',
    title: 'All projects, Last 30 days',
    language: 'en',
    locale: 'en-US',
    timeZone: 'UTC',
    scope: {
      period: { kind: 'rolling', days: 30 },
      comparison: { kind: 'previous' },
      granularity: 'auto',
      defaultBranchOnly: true,
      fullRunsOnly: true,
    },
    scopeText: {
      projects: 'All projects',
      branches: 'Each project’s default branch',
      environments: 'staging, No environment',
      runs: 'Full runs only',
      tests: null,
    },
    period: {
      from: '2026-08-27T00:00:00.000Z',
      to: '2026-09-25T08:00:00.000Z',
      label: 'Last 30 days (Aug 27, 2026 to Sep 25, 2026)',
    },
    comparison: {
      from: '2026-07-28T00:00:00.000Z',
      to: '2026-08-27T00:00:00.000Z',
      label: 'the previous period (Jul 28, 2026 to Aug 26, 2026)',
    },
    dashboard: { ref: 'executive', name: 'Executive' },
    verdict: { tone: 'mixed', sentence: 'The pass rate on main is 89.5%.' },
    bands: [
      {
        title: 'Where things stand',
        description: 'The state of the projects in scope.',
        widgets: [
          {
            key: 'headline',
            type: 'stats',
            title: 'Headline numbers',
            notes: [],
            blocks: [
              {
                kind: 'stats',
                tiles: [
                  {
                    label: 'Test pass rate',
                    value: '89.5%',
                    change: '−1.2 pts',
                    tone: 'bad',
                    note: null,
                    definition: 'Passed over run.',
                  },
                  {
                    label: 'Wasted CI minutes',
                    value: '7.2 min',
                    change: '+12%',
                    tone: 'bad',
                    note: '$3.46',
                    definition: null,
                  },
                ],
              },
            ],
          },
          {
            key: 'trend',
            type: 'metric',
            title: 'Pass rate over time',
            notes: [],
            blocks: [
              {
                kind: 'series',
                unit: 'percent',
                max: 100,
                series: [
                  {
                    label: 'Test pass rate',
                    points: [
                      { date: '2026-09-23', value: 100 },
                      { date: '2026-09-24', value: null },
                      { date: '2026-09-25', value: 80 },
                    ],
                    formatted: ['100%', '—', '80%'],
                    color: 'accent',
                  },
                ],
                markers: [{ date: '2026-09-24', label: HOSTILE }],
                summary: 'Test pass rate: 89.5% (−1.2 pts)',
              },
            ],
          },
        ],
      },
      {
        title: 'Where the pain is',
        description: null,
        widgets: [
          {
            key: 'flaky',
            type: 'flaky-leaderboard',
            title: 'Flakiest tests',
            notes: ['Flakiest tests is not narrowed by the test filter.'],
            blocks: [
              {
                kind: 'table',
                columns: [
                  { key: 'test', label: 'Tests' },
                  { key: 'wasted', label: 'Wasted CI minutes', align: 'right' },
                ],
                rows: [
                  {
                    cells: { test: HOSTILE, wasted: '4 min' },
                    values: { wasted: { number: 4, unit: 'minutes', precision: 0 } },
                    link: 'https://piwi.example/test-cases/1',
                  },
                  { cells: { test: '@smoke logs in', wasted: '1 min' } },
                ],
              },
            ],
          },
          {
            key: 'risks',
            type: 'risks',
            title: 'Risks',
            notes: [],
            blocks: [
              {
                kind: 'list',
                items: [{ text: 'checkout failed its last 3 runs in a row.', tone: 'bad', detail: 'Latest run #12.' }],
              },
            ],
          },
        ],
      },
    ],
    targets: [],
    definitions: [{ id: 'test-pass-rate', label: 'Test pass rate', definition: 'Tests passed divided by tests run.' }],
    limits: ['Days are UTC.'],
  };
}
