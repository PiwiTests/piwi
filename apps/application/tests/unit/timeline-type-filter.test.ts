import { describe, test, expect } from 'vitest';
import { buildFailureTimeline, type TimelineItem, type TimelineLane } from '#shared/failure-timeline';
import {
  TIMELINE_TYPES,
  TIMELINE_TYPE_META,
  countTimelineTypes,
  effectiveHiddenTypes,
  hiddenSummaryRuns,
  isTimelineItemShown,
  onlyHiddenTypes,
  parseHiddenTypes,
  summarizeHiddenItems,
  timelineItemSeverity,
  toggleHiddenType,
} from '../../app/utils/timeline-type-filter';

const T0 = 1_700_000_000_000;

/** A failing execution with every item type: 3 steps, 4 requests, 3 console entries, a dialog, 3 backend logs. */
function timelineItems(): TimelineItem[] {
  const tl = buildFailureTimeline({
    startedAt: T0,
    duration: 6_000,
    status: 'failed',
    steps: [
      { title: 'navigate', category: 'navigation', duration: 1_000, startTime: T0 },
      { title: 'fill email', category: 'input', duration: 500, startTime: T0 + 1_000 },
      { title: 'click Pay', category: 'action', duration: 3_500, startTime: T0 + 1_500, error: 'not enabled' },
    ],
    consoleLogs: [
      { type: 'log', text: 'ready', timestamp: T0 + 200 },
      { type: 'warning', text: 'quote pending', timestamp: T0 + 3_000 },
      { type: 'error', text: 'quote failed', timestamp: T0 + 4_000 },
    ],
    dialogs: [{ type: 'confirm', message: 'Leave?', closedAt: T0 + 100 }],
    networkRequests: [
      { method: 'GET', url: '/', status: 200, duration: 100, startTime: T0 + 50 },
      { method: 'GET', url: '/api/cart', status: 200, duration: 90, startTime: T0 + 1_100 },
      { method: 'POST', url: '/api/pay', status: 201, duration: 80, startTime: T0 + 1_200 },
      {
        method: 'GET',
        url: '/api/quote',
        status: 504,
        duration: 1_500,
        startTime: T0 + 2_000,
        serverLogs: [
          { timestamp: T0 + 2_100, level: 'info', message: 'quote requested' },
          { timestamp: T0 + 3_300, level: 'warn', message: 'quote slow' },
          { timestamp: T0 + 3_400, level: 'error', message: 'quote upstream timed out' },
        ],
      },
    ],
  });
  return TIMELINE_TYPES.flatMap((lane) => tl.lanes[lane]);
}

const hide = (...types: TimelineLane[]) => new Set<TimelineLane>(types);
const runsText = (runs: { text: string }[]) => runs.map((run) => run.text).join('');

describe('TIMELINE_TYPES', () => {
  test('covers exactly the lanes the timeline builds, with a label and nouns for each', () => {
    const lanes = Object.keys(buildFailureTimeline({}).lanes).sort();
    expect([...TIMELINE_TYPES].sort()).toEqual(lanes);
    for (const type of TIMELINE_TYPES) {
      expect(TIMELINE_TYPE_META[type].label).toBeTruthy();
      expect(TIMELINE_TYPE_META[type].one).toBeTruthy();
      expect(TIMELINE_TYPE_META[type].many).toBeTruthy();
    }
  });
});

describe('parseHiddenTypes', () => {
  test('reads anything that is not an array as nothing hidden', () => {
    for (const raw of [null, undefined, 'network', 42, { network: true }]) {
      expect(parseHiddenTypes(raw)).toEqual([]);
    }
  });

  test('keeps known types only, each once, in lane order', () => {
    expect(parseHiddenTypes(['backend', 'network', 'bogus', 3, null, 'network'])).toEqual(['network', 'backend']);
  });
});

describe('isTimelineItemShown', () => {
  const items = timelineItems();
  const failingStep = items.find((item) => item.lane === 'steps' && item.failed)!;
  const passingStep = items.find((item) => item.lane === 'steps' && !item.failed)!;
  const failedRequest = items.find((item) => item.lane === 'network' && item.failed)!;

  test('shows every item when nothing is hidden', () => {
    expect(items.every((item) => isTimelineItemShown(item, hide()))).toBe(true);
  });

  test('hides the items of a hidden type and nothing else', () => {
    const shown = items.filter((item) => isTimelineItemShown(item, hide('network')));
    expect(shown.some((item) => item.lane === 'network')).toBe(false);
    expect(shown).toHaveLength(items.length - 4);
  });

  test('keeps the failing step when steps are hidden', () => {
    expect(isTimelineItemShown(failingStep, hide('steps'))).toBe(true);
    expect(isTimelineItemShown(passingStep, hide('steps'))).toBe(false);
  });

  test('does not keep a failed request — only the failing step stays', () => {
    expect(isTimelineItemShown(failedRequest, hide('network'))).toBe(false);
  });
});

describe('effectiveHiddenTypes', () => {
  const present: TimelineLane[] = ['steps', 'network', 'console'];

  test('keeps the stored types among those present, in lane order', () => {
    expect(effectiveHiddenTypes(['backend', 'network'], present)).toEqual(['network']);
    expect(effectiveHiddenTypes([], present)).toEqual([]);
  });

  test('hides nothing when the stored types would hide every present one', () => {
    // Showing only requests on another execution stores every other type.
    expect(effectiveHiddenTypes(['steps', 'console', 'dialogs', 'backend'], ['steps', 'console'])).toEqual([]);
    expect(effectiveHiddenTypes(['steps', 'network', 'console'], present)).toEqual([]);
  });
});

describe('toggleHiddenType', () => {
  const present: TimelineLane[] = ['steps', 'network', 'console'];

  test('hides a shown type in lane order and shows a hidden one, keeping the stored types not present', () => {
    expect(toggleHiddenType(['backend'], 'network', present)).toEqual(['network', 'backend']);
    expect(toggleHiddenType(['network', 'backend'], 'network', present)).toEqual(['backend']);
  });

  test('never hides the last shown type', () => {
    expect(toggleHiddenType(['steps', 'network'], 'console', present)).toEqual(['steps', 'network']);
  });

  test('acts on what is on screen when the stored types would hide every present one', () => {
    // Every chip shows pressed here, so a click hides the one clicked.
    expect(toggleHiddenType(['steps', 'console', 'dialogs', 'backend'], 'console', ['steps', 'console'])).toEqual([
      'console',
      'dialogs',
      'backend',
    ]);
  });
});

describe('onlyHiddenTypes', () => {
  test('hides every other type, including ones this execution does not have', () => {
    expect(onlyHiddenTypes('console')).toEqual(['steps', 'network', 'dialogs', 'backend']);
  });
});

describe('countTimelineTypes', () => {
  test('counts the items of each type, zero for a type with none', () => {
    expect(countTimelineTypes(timelineItems())).toEqual({ steps: 3, network: 4, console: 3, dialogs: 1, backend: 3 });
    expect(countTimelineTypes([])).toEqual({ steps: 0, network: 0, console: 0, dialogs: 0, backend: 0 });
  });
});

describe('timelineItemSeverity', () => {
  const base = { lane: 'console' as const };

  test('reads failed items, error or fatal entries and uncaught page errors as errors', () => {
    expect(timelineItemSeverity({ lane: 'network', status: '504', failed: true })).toBe('error');
    expect(timelineItemSeverity({ ...base, status: 'error' })).toBe('error');
    expect(timelineItemSeverity({ ...base, status: 'pageerror' })).toBe('error');
    expect(timelineItemSeverity({ lane: 'backend', status: 'FATAL' })).toBe('error');
  });

  test('reads warning and warn entries as warnings', () => {
    expect(timelineItemSeverity({ ...base, status: 'warning' })).toBe('warning');
    expect(timelineItemSeverity({ lane: 'backend', status: 'warn' })).toBe('warning');
  });

  test('reads everything else as ordinary', () => {
    expect(timelineItemSeverity({ ...base, status: 'log' })).toBeNull();
    expect(timelineItemSeverity({ lane: 'network', status: '200' })).toBeNull();
    expect(timelineItemSeverity({ lane: 'dialogs', status: 'confirm' })).toBeNull();
    expect(timelineItemSeverity({ lane: 'steps', status: 'passed' })).toBeNull();
  });
});

describe('summarizeHiddenItems', () => {
  test('is empty when nothing is hidden', () => {
    expect(summarizeHiddenItems(timelineItems(), hide())).toEqual([]);
  });

  test('counts what each hidden type leaves out, and the problems among it, in lane order', () => {
    expect(summarizeHiddenItems(timelineItems(), hide('backend', 'network', 'console'))).toEqual([
      { type: 'network', count: 4, errors: 1, warnings: 0 },
      { type: 'console', count: 3, errors: 1, warnings: 1 },
      { type: 'backend', count: 3, errors: 1, warnings: 1 },
    ]);
  });

  test('leaves the failing step out of the hidden steps', () => {
    expect(summarizeHiddenItems(timelineItems(), hide('steps'))).toEqual([
      { type: 'steps', count: 2, errors: 0, warnings: 0 },
    ]);
  });
});

describe('hiddenSummaryRuns', () => {
  test('reads as one line, naming the failed requests and the errors and warnings', () => {
    const runs = hiddenSummaryRuns(summarizeHiddenItems(timelineItems(), hide('network', 'backend')));
    expect(runsText(runs)).toBe('4 requests (1 failed), 3 backend logs (1 error, 1 warning)');
    expect(runs.filter((run) => run.severity)).toEqual([
      { text: '1 failed', severity: 'error' },
      { text: '1 error', severity: 'error' },
      { text: '1 warning', severity: 'warning' },
    ]);
  });

  test('uses the singular for one item and adds nothing for an ordinary type', () => {
    const one = (type: TimelineLane) => runsText(hiddenSummaryRuns([{ type, count: 1, errors: 0, warnings: 0 }]));
    expect(one('steps')).toBe('1 step');
    expect(one('network')).toBe('1 request');
    expect(one('console')).toBe('1 console entry');
    expect(one('dialogs')).toBe('1 dialog');
    expect(one('backend')).toBe('1 backend log');
  });

  test('pluralizes counts and problem counts', () => {
    const runs = hiddenSummaryRuns([{ type: 'console', count: 5, errors: 2, warnings: 3 }]);
    expect(runsText(runs)).toBe('5 console entries (2 errors, 3 warnings)');
  });

  test('is empty when nothing is hidden', () => {
    expect(hiddenSummaryRuns([])).toEqual([]);
  });
});
