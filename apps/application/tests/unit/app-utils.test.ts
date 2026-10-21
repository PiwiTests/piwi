import { describe, test, expect, vi } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatLongDuration,
  splitDuration,
  prettyDateFormat,
  formatRelativeTime,
  getStatusColor,
  getStatusIcon,
  getStatusTextClass,
  isStatusInFlight,
  toTestPriority,
  formatStatusLabel,
  isFailedStatus,
  failureFirstCompare,
  clusterStatusColor,
  clusterErrorTypeColor,
  fixVerificationBadge,
  getFileApiPath,
  fileApiUrl,
  getTraceViewerUrl,
  errorMessage,
  filterCommits,
  scmFileStatusMeta,
  parsePatchLines,
  patchLineClass,
  renderAnsi,
  copyPreview,
  reportIcon,
  getBrowserIcon,
} from '../../app/utils/index';

describe('formatBytes', () => {
  test('handles zero / empty as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });

  test('scales into KB/MB with two decimals', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1048576)).toBe('1.00 MB');
  });
});

describe('formatLongDuration', () => {
  test('returns N/A for nullish input', () => {
    expect(formatLongDuration(null)).toBe('N/A');
    expect(formatLongDuration(undefined)).toBe('N/A');
  });

  test('normalizes a long span into human units instead of raw seconds', () => {
    // formatDuration renders this as "50400 seconds" — the reason this exists.
    expect(formatLongDuration(50_400_000)).toBe('14 hours');
    expect(formatLongDuration(3_600_000)).toBe('1 hour');
  });

  test('keeps only the two largest units', () => {
    // 2 days, 3 hours, 4 minutes — the minutes are dropped.
    expect(formatLongDuration((2 * 24 * 3600 + 3 * 3600 + 4 * 60) * 1000)).toBe('2 days 3 hours');
  });

  test('floors sub-second spans and signs negatives', () => {
    expect(formatLongDuration(10)).toBe('less than a second');
    expect(formatLongDuration(-3_600_000)).toBe('−1 hour');
  });
});

describe('formatDuration', () => {
  test('returns N/A for nullish input', () => {
    expect(formatDuration(null)).toBe('N/A');
    expect(formatDuration(undefined)).toBe('N/A');
  });

  test('formats seconds and prefixes a minus sign for negative durations', () => {
    expect(formatDuration(5000)).toBe('5 seconds');
    expect(formatDuration(-5000)).toBe('−5 seconds');
  });

  test('rounds fractional milliseconds to at most 3 decimals of seconds', () => {
    expect(formatDuration(8234.666666667)).toBe('8.235 seconds');
    expect(formatDuration(1234.5678)).toBe('1.235 seconds');
    expect(formatDuration(1234)).toBe('1.234 seconds');
    expect(formatDuration(-1234.5678)).toBe('−1.235 seconds');
  });

  test('renders zero durations as 0 seconds instead of an empty string', () => {
    expect(formatDuration(0)).toBe('0 seconds');
    expect(formatDuration(0.2)).toBe('0 seconds');
  });
});

describe('splitDuration', () => {
  test('returns null for nullish input', () => {
    expect(splitDuration(null)).toBeNull();
    expect(splitDuration(undefined)).toBeNull();
  });

  test('uses ms below one second (rounded)', () => {
    expect(splitDuration(210)).toEqual({ value: '210', unit: 'ms' });
    expect(splitDuration(0)).toEqual({ value: '0', unit: 'ms' });
    expect(splitDuration(45.6)).toEqual({ value: '46', unit: 'ms' });
  });

  test('uses seconds from 1s to under a minute (one decimal)', () => {
    expect(splitDuration(1240)).toEqual({ value: '1.2', unit: 's' });
    expect(splitDuration(5000)).toEqual({ value: '5', unit: 's' });
    expect(splitDuration(59900)).toEqual({ value: '59.9', unit: 's' });
  });

  test('uses minutes at or above 60s and prefixes negatives', () => {
    expect(splitDuration(90000)).toEqual({ value: '1.5', unit: 'm' });
    expect(splitDuration(-250)).toEqual({ value: '−250', unit: 'ms' });
  });
});

describe('prettyDateFormat', () => {
  test('returns N/A for empty or invalid input', () => {
    expect(prettyDateFormat(null)).toBe('N/A');
    expect(prettyDateFormat('')).toBe('N/A');
    expect(prettyDateFormat('not-a-date')).toBe('N/A');
  });

  test('renders a valid date to a non-N/A string', () => {
    expect(prettyDateFormat(new Date('2024-01-01T00:00:00Z'))).not.toBe('N/A');
  });
});

describe('formatRelativeTime', () => {
  test('returns N/A for nullish input', () => {
    expect(formatRelativeTime(null)).toBe('N/A');
  });

  test('renders a past date with an "ago" suffix', () => {
    expect(formatRelativeTime(new Date(Date.now() - 60_000))).toContain('ago');
  });
});

describe('getStatusColor', () => {
  test('maps known statuses to badge colors', () => {
    expect(getStatusColor('passed')).toBe('success');
    expect(getStatusColor('failed')).toBe('error');
    expect(getStatusColor('flaky')).toBe('flaky');
    expect(getStatusColor('didnotrun')).toBe('warning');
    expect(getStatusColor('running')).toBe('info');
    expect(getStatusColor('finalizing')).toBe('info');
    expect(getStatusColor('cancelled')).toBe('neutral');
    expect(getStatusColor('never-run')).toBe('neutral');
  });

  test('reads timed-out and interrupted as failed, like the run counters', () => {
    expect(getStatusColor('timedout')).toBe('error');
    expect(getStatusColor('timedOut')).toBe('error');
    expect(getStatusColor('interrupted')).toBe('error');
  });

  test('falls back to neutral for unknown statuses', () => {
    expect(getStatusColor('whatever')).toBe('neutral');
  });
});

describe('formatStatusLabel', () => {
  test('renders timedOut/timedout as "timed out" and didnotrun as "didn\'t run"', () => {
    expect(formatStatusLabel('timedOut')).toBe('timed out');
    expect(formatStatusLabel('timedout')).toBe('timed out');
    expect(formatStatusLabel('didnotrun')).toBe("didn't run");
    expect(formatStatusLabel('never-run')).toBe('never run');
    expect(formatStatusLabel('passed')).toBe('passed');
  });
});

describe('isFailedStatus', () => {
  test('treats both timeout spellings as failures, like the run counters', () => {
    expect(isFailedStatus('failed')).toBe(true);
    expect(isFailedStatus('timedOut')).toBe(true);
    expect(isFailedStatus('timedout')).toBe(true);
    expect(isFailedStatus('passed')).toBe(false);
    expect(isFailedStatus('skipped')).toBe(false);
    expect(isFailedStatus('didnotrun')).toBe(false);
    expect(isFailedStatus('running')).toBe(false);
  });
});

describe('failureFirstCompare', () => {
  test('orders failures (including timeouts) before everything else', () => {
    const order = ['passed', 'failed', 'skipped', 'timedOut', 'passed'].sort(failureFirstCompare);
    expect(order.slice(0, 2)).toEqual(['failed', 'timedOut']);
  });

  test('keeps the relative order within each group (stable)', () => {
    const order = ['passed', 'failed', 'skipped', 'passed', 'failed'].sort(failureFirstCompare);
    expect(order).toEqual(['failed', 'failed', 'passed', 'skipped', 'passed']);
  });

  test('is a no-op when nothing failed', () => {
    const order = ['passed', 'skipped', 'didnotrun'].sort(failureFirstCompare);
    expect(order).toEqual(['passed', 'skipped', 'didnotrun']);
  });
});

describe('status icon helpers', () => {
  test('maps both spellings of a timeout to the failed icon and color', () => {
    expect(getStatusIcon('timedOut')).toBe(getStatusIcon('failed'));
    expect(getStatusIcon('timedout')).toBe(getStatusIcon('failed'));
    expect(getStatusTextClass('timedOut')).toBe(getStatusTextClass('failed'));
  });

  test('gives each outcome its own icon', () => {
    expect(getStatusIcon('passed')).toBe('i-lucide-check-circle-2');
    expect(getStatusIcon('failed')).toBe('i-lucide-x-circle');
    expect(getStatusIcon('flaky')).toBe('i-lucide-shuffle');
    expect(getStatusIcon('didnotrun')).toBe('i-lucide-circle-slash');
    expect(getStatusIcon('running')).toBe('i-lucide-loader-circle');
    expect(getStatusIcon('skipped')).toBe('i-lucide-minus-circle');
  });

  test('gives each outcome its own colour, and one colour to the in-flight three', () => {
    expect(getStatusTextClass('passed')).toContain('emerald');
    expect(getStatusTextClass('failed')).toContain('rose');
    expect(getStatusTextClass('flaky')).toContain('fuchsia');
    expect(getStatusTextClass('didnotrun')).toContain('amber');
    expect(getStatusTextClass('running')).toContain('blue');
    expect(getStatusTextClass('initializing')).toBe(getStatusTextClass('running'));
    expect(getStatusTextClass('finalizing')).toBe(getStatusTextClass('running'));
    expect(getStatusTextClass('skipped')).toContain('zinc');
  });

  test('only the in-flight statuses spin', () => {
    expect(isStatusInFlight('running')).toBe(true);
    expect(isStatusInFlight('initializing')).toBe(true);
    expect(isStatusInFlight('finalizing')).toBe(true);
    expect(isStatusInFlight('passed')).toBe(false);
    expect(isStatusInFlight('timedOut')).toBe(false);
  });
});

describe('toTestPriority', () => {
  test('keeps a declared priority and drops anything the DB happens to hold', () => {
    expect(toTestPriority('critical')).toBe('critical');
    expect(toTestPriority('low')).toBe('low');
    expect(toTestPriority('urgent')).toBeUndefined();
    expect(toTestPriority('')).toBeUndefined();
    expect(toTestPriority(null)).toBeUndefined();
    expect(toTestPriority(undefined)).toBeUndefined();
  });
});

describe('cluster color helpers', () => {
  test('clusterStatusColor', () => {
    expect(clusterStatusColor('open')).toBe('warning');
    expect(clusterStatusColor('resolved')).toBe('success');
    expect(clusterStatusColor('ignored')).toBe('neutral');
    expect(clusterStatusColor(null)).toBe('neutral');
    expect(clusterStatusColor('mystery')).toBe('neutral');
  });

  test('clusterErrorTypeColor', () => {
    expect(clusterErrorTypeColor('timeout')).toBe('warning');
    expect(clusterErrorTypeColor('assertion')).toBe('error');
    expect(clusterErrorTypeColor('strict-mode')).toBe('info');
    expect(clusterErrorTypeColor('navigation')).toBe('secondary');
    expect(clusterErrorTypeColor('crash')).toBe('error');
    expect(clusterErrorTypeColor(null)).toBe('neutral');
  });

  describe('fixVerificationBadge', () => {
    // Null is what keeps the resolution block off the clusters nobody fixed.
    test('is null until a fix has landed', () => {
      expect(fixVerificationBadge(null)).toBeNull();
      expect(fixVerificationBadge(undefined)).toBeNull();
      expect(fixVerificationBadge('something-else')).toBeNull();
    });

    test('only the corroborated verdict claims the fix was verified', () => {
      expect(fixVerificationBadge('diagnosis-verified')).toMatchObject({ label: 'Verified', color: 'success' });
      // "Stopped failing" must not read as a verified fix — nothing says which
      // change did it.
      expect(fixVerificationBadge('stopped-failing')).toMatchObject({ label: 'Stopped failing', color: 'info' });
      expect(fixVerificationBadge('regressed')).toMatchObject({ label: 'Regressed', color: 'error' });
    });

    test('every verdict explains itself', () => {
      for (const verdict of ['diagnosis-verified', 'stopped-failing', 'regressed']) {
        expect(fixVerificationBadge(verdict)!.hint.length, verdict).toBeGreaterThan(20);
      }
    });
  });
});

describe('file path helpers', () => {
  test('getFileApiPath strips the storage prefix and passes relative paths through', () => {
    expect(getFileApiPath('.data/storage/reports/index.html')).toBe('reports/index.html');
    expect(getFileApiPath('reports/index.html')).toBe('reports/index.html');
  });

  test('fileApiUrl prefixes the base path so the URL stays inside a sub-path deployment', () => {
    expect(fileApiUrl('.data/storage/screenshots/a.png')).toBe('/api/files/screenshots/a.png');
    expect(fileApiUrl('demo/screenshots/a.png', null, '/demo/')).toBe('/demo/api/files/demo/screenshots/a.png');
  });

  test('fileApiUrl forwards contentType only for extension-less paths', () => {
    expect(fileApiUrl('attachments/blob', 'image/png')).toBe('/api/files/attachments/blob?contentType=image%2Fpng');
    expect(fileApiUrl('attachments/a.png', 'image/png')).toBe('/api/files/attachments/a.png');
  });

  test('fileApiUrl combines the compress flag with the base path and contentType', () => {
    expect(fileApiUrl('demo/screenshots/a.png', null, '/demo/', true)).toBe(
      '/demo/api/files/demo/screenshots/a.png?compress=1',
    );
    expect(fileApiUrl('attachments/blob', 'image/png', '/demo/', true)).toBe(
      '/demo/api/files/attachments/blob?contentType=image%2Fpng&compress=1',
    );
  });

  test('getTraceViewerUrl embeds the encoded root-relative file API URL', () => {
    const url = getTraceViewerUrl('.data/storage/t.zip');
    expect(url).toBe(`/trace-viewer/?trace=${encodeURIComponent('/api/files/t.zip')}`);
  });

  test('getTraceViewerUrl prefixes the base path for both the viewer and the trace URL', () => {
    const url = getTraceViewerUrl('.data/storage/t.zip', '/demo/');
    expect(url).toBe(`/demo/trace-viewer/?trace=${encodeURIComponent('/demo/api/files/t.zip')}`);
  });

  test('getTraceViewerUrl builds the same link with and without a browser location (SSR)', () => {
    vi.stubGlobal('location', { origin: 'http://localhost:3000' });
    const inBrowser = getTraceViewerUrl('t.zip', '/demo/');
    vi.stubGlobal('location', undefined);
    const onServer = getTraceViewerUrl('t.zip', '/demo/');
    vi.unstubAllGlobals();
    expect(inBrowser).toBe(onServer);
  });

  test('getTraceViewerUrl points at the static asset URL when staticAsset is set (demo mode)', () => {
    const url = getTraceViewerUrl('demo/traces/t.zip', '/demo/', true);
    expect(url).toBe(`/demo/trace-viewer/?trace=${encodeURIComponent('/demo/demo/traces/t.zip')}`);
  });
});

describe('errorMessage (fetch error unwrapping)', () => {
  test('unwraps the { data: { message } } shape', () => {
    expect(errorMessage({ data: { message: 'Boom' } })).toBe('Boom');
  });

  test('falls back to the top-level message', () => {
    expect(errorMessage({ message: 'Plain' })).toBe('Plain');
  });

  test('returns the fallback for non-object / empty values', () => {
    expect(errorMessage('a string')).toBe('Unknown error');
    expect(errorMessage(null)).toBe('Unknown error');
    expect(errorMessage({}, 'custom fallback')).toBe('custom fallback');
  });
});

describe('filterCommits', () => {
  const commits = [
    { sha: 'aaa111bbb', shortSha: 'aaa111b', message: 'Fix login bug', author: 'Alice' },
    { sha: 'ccc222ddd', shortSha: 'ccc222d', message: 'Add dashboard', author: 'Bob' },
  ] as never[];

  test('returns all commits for an empty query', () => {
    expect(filterCommits(commits, '   ')).toHaveLength(2);
  });

  test('matches on message, author, and sha (case-insensitive)', () => {
    expect(filterCommits(commits, 'login')).toHaveLength(1);
    expect(filterCommits(commits, 'bob')).toHaveLength(1);
    expect(filterCommits(commits, 'ccc222')).toHaveLength(1);
    expect(filterCommits(commits, 'nomatch')).toHaveLength(0);
  });
});

describe('scmFileStatusMeta', () => {
  test('maps status to icon + badge color', () => {
    expect(scmFileStatusMeta('added').badgeColor).toBe('success');
    expect(scmFileStatusMeta('removed').badgeColor).toBe('error');
    expect(scmFileStatusMeta('renamed').badgeColor).toBe('info');
    expect(scmFileStatusMeta('modified').badgeColor).toBe('neutral');
  });
});

describe('parsePatchLines', () => {
  test('classifies added, removed, hunk and context lines', () => {
    const lines = parsePatchLines(
      ['@@ -1,2 +1,2 @@', '+added', '-removed', ' context', '+++ b/file', '--- a/file'].join('\n'),
    );
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'add', 'remove', 'context', 'context', 'context']);
  });

  test('inside a hunk, a removed `--` line and an added `++` line are changes, not file headers', () => {
    const lines = parsePatchLines(
      [
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -1,2 +1,2 @@',
        '--- the old note',
        '+++ the new note',
        ' select 1;',
        '--- a/next',
      ].join('\n'),
    );
    expect(lines.map((l) => l.type)).toEqual(['context', 'context', 'hunk', 'remove', 'add', 'context', 'context']);
  });

  test('patchLineClass has an entry for every line type', () => {
    expect(Object.keys(patchLineClass).sort()).toEqual(['add', 'context', 'hunk', 'remove']);
  });
});

describe('renderAnsi', () => {
  test('escapes HTML in plain text', () => {
    expect(renderAnsi('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  test('wraps colored segments in styled spans and resets on code 0', () => {
    expect(renderAnsi('\u001B[31mred\u001B[0m')).toBe('<span style="color:#dc2626">red</span>');
  });
});

describe('copyPreview', () => {
  test('returns empty string for nullish input', () => {
    expect(copyPreview(null)).toBe('');
    expect(copyPreview(undefined)).toBe('');
  });

  test('joins newlines with a middot and truncates past the cap', () => {
    expect(copyPreview('a\nb')).toBe('a · b');
    expect(copyPreview('x'.repeat(200), 10)).toBe('xxxxxxxxxx…');
  });
});

describe('icon helpers', () => {
  test('reportIcon maps known report types', () => {
    expect(reportIcon('html')).toBe('i-lucide-layout-dashboard');
    expect(reportIcon('blob')).toBe('i-lucide-download');
    expect(reportIcon('unknown')).toBe('i-lucide-file-text');
  });

  test('getBrowserIcon maps browser families', () => {
    expect(getBrowserIcon('chromium')).toBe('i-simple-icons-googlechrome');
    expect(getBrowserIcon('firefox')).toBe('i-simple-icons-firefoxbrowser');
    expect(getBrowserIcon('webkit')).toBe('i-simple-icons-safari');
    expect(getBrowserIcon(null)).toBe('i-lucide-globe');
  });
});
