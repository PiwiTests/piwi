import type { BugReportStatus, BugReproductionVerdict } from '#shared/handlers/bug-reports';

/** How a bug report's status reads, and the badge color it takes. */
export const BUG_REPORT_STATUS: Record<
  BugReportStatus,
  { label: string; color: 'error' | 'warning' | 'success' | 'neutral'; hint: string }
> = {
  open: { label: 'Open', color: 'error', hint: 'Reported; no test in the suite names it yet.' },
  'test-committed': {
    label: 'Test committed',
    color: 'warning',
    hint: 'A test names it with piwi:bug and still shows the bug.',
  },
  'looks-fixed': {
    label: 'Looks fixed',
    color: 'success',
    hint: 'Its test, marked test.fail(), passed: remove test.fail() with the fix.',
  },
  closed: { label: 'Closed', color: 'neutral', hint: 'Its test passes as an ordinary test.' },
  dismissed: { label: 'Dismissed', color: 'neutral', hint: 'Set aside by hand; runs no longer move it.' },
};

export const BUG_REPORT_STATUS_ITEMS = [
  { label: 'All statuses', value: 'all' },
  ...(Object.keys(BUG_REPORT_STATUS) as BugReportStatus[]).map((value) => ({
    label: BUG_REPORT_STATUS[value].label,
    value,
  })),
];

export function verdictLabel(verdict: BugReproductionVerdict, divergedAt?: number | null): string {
  if (verdict === 'reproduced') return 'Reproduced';
  if (verdict === 'not-reproduced') return 'Not reproduced';
  return divergedAt != null ? `Diverged at step ${divergedAt + 1}` : 'Diverged';
}

/** Where a reproduction happened: `localhost:3000` rather than the full origin. */
export function reproductionPlace(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
