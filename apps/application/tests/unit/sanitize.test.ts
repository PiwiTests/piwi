import { describe, test, expect } from 'vitest';
import {
  sanitizeUrl,
  sanitizeNetworkRequests,
  sanitizeWebVitals,
  sanitizeGitRemoteUrl,
  sanitizeMetadata,
  sanitizeConsoleLogs,
  sanitizeAiUsage,
  sanitizeDialogs,
  capSteps,
  DROPPED_STEPS_CATEGORY,
} from '../../server/utils/sanitize';
import { DEFAULT_INGEST_LIMITS } from '#shared/ingest-limits';

describe('sanitizeUrl', () => {
  test('strips query string and fragment, keeping scheme + host + path', () => {
    expect(sanitizeUrl('https://example.com/path?token=secret#frag')).toBe('https://example.com/path');
  });

  test('drops embedded credentials via the host', () => {
    expect(sanitizeUrl('https://user:pass@example.com/p?q=1')).toBe('https://example.com/p');
  });

  test('returns unparseable (relative) inputs unchanged', () => {
    expect(sanitizeUrl('/relative/path?x=1')).toBe('/relative/path?x=1');
    expect(sanitizeUrl('not a url at all')).toBe('not a url at all');
  });
});

describe('sanitizeGitRemoteUrl (secret leak prevention)', () => {
  test('strips a token-style userinfo from an https remote', () => {
    expect(sanitizeGitRemoteUrl('https://x-access-token:ghs_abc123@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  test('strips user:pass userinfo', () => {
    expect(sanitizeGitRemoteUrl('https://alice:hunter2@gitlab.com/o/r.git')).toBe('https://gitlab.com/o/r.git');
  });

  test('leaves a credential-free https remote intact', () => {
    expect(sanitizeGitRemoteUrl('https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  test('returns an SSH remote (unparseable as URL) unchanged', () => {
    expect(sanitizeGitRemoteUrl('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
  });

  test('drops a URL of a scheme a git remote does not use', () => {
    expect(sanitizeGitRemoteUrl('javascript://github.com/%0aalert(1)')).toBeNull();
    expect(sanitizeGitRemoteUrl(' javascript:alert(1)')).toBeNull();
    expect(sanitizeGitRemoteUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeGitRemoteUrl('ssh://git@github.com/org/repo.git')).toBe('ssh://github.com/org/repo.git');
  });

  test('sanitizeMetadata leaves out a remote URL it drops', () => {
    expect(sanitizeMetadata({ scm: { remoteUrl: 'javascript:alert(1)', commit: 'abc' } })).toEqual({
      scm: { commit: 'abc' },
    });
  });
});

describe('sanitizeNetworkRequests', () => {
  test('returns null for missing or non-array input', () => {
    expect(sanitizeNetworkRequests(null)).toBeNull();
    expect(sanitizeNetworkRequests(undefined)).toBeNull();
    expect(sanitizeNetworkRequests('nope' as unknown as unknown[])).toBeNull();
  });

  test('strips query params from surviving request URLs', () => {
    const out = sanitizeNetworkRequests([
      { url: 'https://api.example.com/data?token=secret', resourceType: 'fetch', status: 200, duration: 10 },
    ]);
    expect(out).not.toBeNull();
    expect(out![0]!.url).toBe('https://api.example.com/data');
  });

  test('returns null when nothing survives filtering', () => {
    expect(sanitizeNetworkRequests([])).toBeNull();
  });
});

describe('sanitizeWebVitals', () => {
  test('strips the query string from the navigation URL', () => {
    expect(sanitizeWebVitals({ navigation: { url: 'https://app.example.com/p?u=alice' }, lcp: 1200 })).toEqual({
      navigation: { url: 'https://app.example.com/p' },
      lcp: 1200,
    });
  });

  test('passes vitals through unchanged when there is no navigation block', () => {
    expect(sanitizeWebVitals({ lcp: 900 })).toEqual({ lcp: 900 });
  });

  test('returns null for empty input', () => {
    expect(sanitizeWebVitals(null)).toBeNull();
  });
});

describe('sanitizeMetadata', () => {
  test('strips credentials from scm.remoteUrl', () => {
    expect(sanitizeMetadata({ scm: { remoteUrl: 'https://tok@github.com/o/r.git', branch: 'main' } })).toEqual({
      scm: { remoteUrl: 'https://github.com/o/r.git', branch: 'main' },
    });
  });

  test('leaves metadata without an scm block untouched', () => {
    expect(sanitizeMetadata({ ci: { provider: 'github' } })).toEqual({ ci: { provider: 'github' } });
  });

  test("rebuilds the run's origin as { kind, ref } and drops one naming no known kind", () => {
    const kept = sanitizeMetadata({ piwiOrigin: { ref: ' 214 ', kind: 'bisect', extra: true } });
    expect(kept).toEqual({ piwiOrigin: { kind: 'bisect', ref: '214' } });
    expect(JSON.stringify(kept)).toBe('{"piwiOrigin":{"kind":"bisect","ref":"214"}}');
    expect(sanitizeMetadata({ piwiOrigin: { kind: 'nightly' }, scm: {} })).toEqual({ scm: {} });
  });

  test('returns null for empty input', () => {
    expect(sanitizeMetadata(null)).toBeNull();
  });
});

describe('sanitizeConsoleLogs', () => {
  test('strips the query string from the URL part of the location', () => {
    const out = sanitizeConsoleLogs([{ type: 'error', text: 'boom', location: 'https://app.example.com/p?u=1:12:5' }]);
    expect(out![0]!.location).toBe('https://app.example.com/p:12:5');
  });

  test('leaves entries whose location is not a url:line:col string', () => {
    const entry = { type: 'log', text: 'hi', location: 'not-a-location' };
    expect(sanitizeConsoleLogs([entry])![0]).toEqual(entry);
  });

  test('returns null for missing input', () => {
    expect(sanitizeConsoleLogs(null)).toBeNull();
  });
});

describe('sanitizeAiUsage', () => {
  const intent = {
    template: 'the email address field',
    locator: "getByRole('textbox', { name: 'Email' })",
    kind: 'locator',
  };

  test('keeps well-shaped entries and intents', () => {
    const out = sanitizeAiUsage({ entries: ['a/__piwi__/x.json'], intents: [intent] });
    expect(out).toEqual({ entries: ['a/__piwi__/x.json'], intents: [intent] });
  });

  test('omits the intents field when none survive', () => {
    expect(sanitizeAiUsage({ entries: ['a.json'] })).toEqual({ entries: ['a.json'] });
    expect(sanitizeAiUsage({ entries: ['a.json'], intents: 'nope' })).toEqual({ entries: ['a.json'] });
  });

  test('drops malformed intents and clamps counts and lengths', () => {
    const out = sanitizeAiUsage({
      entries: ['a.json'],
      intents: [
        intent,
        { template: 42, locator: 'x', kind: 'locator' }, // non-string template
        { template: 'ok', locator: 'x', kind: 'evil' }, // unknown kind
        null,
        { template: 'long'.repeat(200), locator: 'y'.repeat(1000), kind: 'run' },
      ],
    });
    expect(out?.intents).toHaveLength(2);
    expect(out?.intents?.[1]?.template.length).toBe(300);
    expect(out?.intents?.[1]?.locator.length).toBe(400);
  });

  test('returns null without entries, even when intents exist', () => {
    expect(sanitizeAiUsage({ intents: [intent] })).toBeNull();
    expect(sanitizeAiUsage({ entries: [], intents: [intent] })).toBeNull();
    expect(sanitizeAiUsage(null)).toBeNull();
  });
});

describe('capSteps', () => {
  test('caps the step count to the limit', () => {
    const steps = Array.from({ length: DEFAULT_INGEST_LIMITS.steps + 5 }, (_, i) => ({ title: `s${i}`, duration: 1 }));
    const out = capSteps(steps, DEFAULT_INGEST_LIMITS) as unknown[];
    expect(out).toHaveLength(DEFAULT_INGEST_LIMITS.steps);
  });

  test('keeps the failing step past the cap and marks how many steps it dropped', () => {
    const limits = { ...DEFAULT_INGEST_LIMITS, steps: 5 };
    const steps = [
      ...Array.from({ length: 8 }, (_, i) => ({ title: `click ${i}`, category: 'pw:api', duration: 1, depth: 1 })),
      { title: 'checkout', category: 'test.step', duration: 1, depth: 0, failed: true, error: { message: 'boom' } },
      { title: 'click pay', category: 'pw:api', duration: 1, depth: 1, failed: true, error: { message: 'boom' } },
      { title: 'screenshot', category: 'pw:api', duration: 1, depth: 0 },
    ];
    const out = capSteps(steps, limits) as Array<{ title: string; category: string; depth?: number }>;
    expect(out.map((s) => s.title)).toEqual(['click 0', 'click 1', '7 steps not stored', 'checkout', 'click pay']);
    expect(out[2]).toMatchObject({ category: DROPPED_STEPS_CATEGORY, depth: 0 });
  });

  test('re-caps params keys and value length, never trusting the reporter', () => {
    const params: Record<string, string> = {};
    for (let i = 0; i < DEFAULT_INGEST_LIMITS.stepParamKeys + 10; i++) params[`k${i}`] = 'v';
    params.long = 'a'.repeat(DEFAULT_INGEST_LIMITS.stepParamValueChars + 100);
    const out = capSteps([{ title: 'Click', duration: 1, params }], DEFAULT_INGEST_LIMITS) as Array<{
      params: Record<string, string>;
    }>;
    expect(Object.keys(out[0]!.params).length).toBe(DEFAULT_INGEST_LIMITS.stepParamKeys);
  });

  test('ends a value cut on ingest with a marker', () => {
    const limits = { ...DEFAULT_INGEST_LIMITS, stepParamValueChars: 20 };
    const locator = "getByRole('form').getByLabel('Country')";
    const out = capSteps([{ title: 'Click', duration: 1, subtitle: locator, params: { locator } }], limits) as Array<{
      subtitle: string;
      params: Record<string, string>;
    }>;
    expect(out[0]!.params.locator).toBe("getByRole('form').g…");
    expect(out[0]!.subtitle).toBe("getByRole('form').g…");
  });

  test('masks token-shaped param values and subtitles on ingest', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456';
    const out = capSteps(
      [{ title: 'Set token', duration: 1, subtitle: jwt, params: { token: jwt } }],
      DEFAULT_INGEST_LIMITS,
    ) as Array<{ subtitle: string; params: Record<string, string> }>;
    expect(out[0]!.params.token).toBe('[masked-token]');
    expect(out[0]!.subtitle).toBe('[masked-token]');
  });

  test('drops non-object params rather than trusting them through', () => {
    const out = capSteps([{ title: 'Click', duration: 1, params: 'not-an-object' }], DEFAULT_INGEST_LIMITS) as Array<
      Record<string, unknown>
    >;
    expect('params' in out[0]!).toBe(false);
  });
});

describe('sanitizeDialogs', () => {
  test('keeps recognized fields and drops unknown ones', () => {
    const out = sanitizeDialogs([
      { type: 'confirm', message: 'Stay signed in?', defaultValue: 'yes', closedAt: 123, extra: 'x' },
    ]);
    expect(out).toEqual([{ type: 'confirm', message: 'Stay signed in?', defaultValue: 'yes', closedAt: 123 }]);
  });

  test('masks a token-shaped dialog message', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456';
    const out = sanitizeDialogs([{ type: 'prompt', message: jwt }]) as Array<{ message: string }>;
    expect(out[0]!.message).toBe('[masked-token]');
  });

  test('returns null for non-arrays and empty results', () => {
    expect(sanitizeDialogs(null)).toBeNull();
    expect(sanitizeDialogs('nope')).toBeNull();
    expect(sanitizeDialogs([42, null])).toBeNull();
  });
});
