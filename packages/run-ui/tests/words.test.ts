import { describe, expect, test } from 'vitest';
import {
  connectionErrorWords,
  connectionStateWords,
  optionWords,
  requestCheckWords,
  teamInstanceHost,
  testCountWords,
} from '../app/utils/run-target-words';

describe('teamInstanceHost', () => {
  test('names the host of an address', () => {
    expect(teamInstanceHost('https://piwi.example.com:8443/some/path')).toBe('piwi.example.com:8443');
  });

  test('keeps what is not a URL as given, and names none', () => {
    expect(teamInstanceHost('not a url')).toBe('not a url');
    expect(teamInstanceHost(null)).toBe('your team instance');
    expect(teamInstanceHost('')).toBe('your team instance');
  });
});

describe('testCountWords', () => {
  test('says a test for one and a count for the rest', () => {
    expect(testCountWords(1)).toBe('a test');
    expect(testCountWords(3)).toBe('3 tests');
  });
});

describe('optionWords', () => {
  test('lists only what the request sets', () => {
    expect(optionWords({ headed: false })).toEqual(['headless']);
    expect(optionWords({ headed: true, trace: 'on', repeatEach: 3, workers: 2, project: 'chromium' })).toEqual([
      'headed',
      'trace on',
      'repeat 3×',
      '2 workers',
      'project chromium',
    ]);
    expect(optionWords({ headed: false, workers: 1 })).toEqual(['headless', '1 worker']);
    expect(optionWords({ headed: false, repeatEach: 1 })).toEqual(['headless']);
  });

  test('is empty without options', () => {
    expect(optionWords(null)).toEqual([]);
    expect(optionWords(undefined)).toEqual([]);
  });
});

describe('connectionStateWords', () => {
  test('has words for every state of the connection', () => {
    const states = ['connecting', 'none', 'offline', 'online', 'revoked', 'signing-in'] as const;
    for (const state of states) expect(connectionStateWords(state)).not.toMatch(/^runui_/);
    expect(connectionStateWords('online')).toBe('Connected: requests from your pages come here');
  });
});

describe('the host’s sentences, by their code', () => {
  test('say in English what the host’s English sentence says', async () => {
    const { requestCheckSentence } = await import('@piwitests/editor/request-run');
    const cases: Array<[Parameters<typeof requestCheckSentence>[0], Record<string, string | number>]> = [
      ['folder-none', {}],
      ['folder-gone', {}],
      ['folder-linked', { folder: '/home/dana/shop' }],
      ['variables-invalid', { problems: 'PATH is a name the shell keeps.' }],
      ['variables-set', { variables: 'BASE_URL=https://staging.example.com' }],
      ['environment-set', { environment: 'Staging', key: 'staging' }],
      ['environment-protected', { environment: 'Production', key: 'production', tags: '@smoke, @readonly' }],
      ['folder-busy', {}],
      ['config-missing', {}],
      ['specs-missing', { files: 'a.spec.ts, b.spec.ts', more: 0 }],
      ['specs-missing', { files: 'a.spec.ts, b.spec.ts, c.spec.ts', more: 4 }],
      ['specs-found', {}],
      ['playwright-missing', {}],
      ['playwright-installed', {}],
      ['commit-differs', { branch: 'main', commit: '1a2b3c4', sourceBranch: 'feat', sourceCommit: '5d6e7f8' }],
      ['commit-differs', { branch: '', commit: '1a2b3c4', sourceBranch: '', sourceCommit: '5d6e7f8' }],
      ['commit-differs', { branch: 'main', commit: '', sourceBranch: 'feat', sourceCommit: '5d6e7f8' }],
      ['commit-differs', { branch: '', commit: '', sourceBranch: '', sourceCommit: '5d6e7f8' }],
      ['commit-same', {}],
      ['changes-uncommitted', {}],
      ['command-too-long', { max: 24000 }],
    ];
    for (const [code, args] of cases) {
      const message = requestCheckSentence(code, args);
      expect(requestCheckWords({ code, args, message }), code).toBe(message);
    }
  });

  test('show a check of a code the window does not know as the host wrote it', () => {
    const check = { code: 'later' as never, args: {}, message: 'A check of a newer host.' };
    expect(requestCheckWords(check)).toBe('A check of a newer host.');
  });

  test('word the connection’s errors as the host does, and show the instance’s own as it came', async () => {
    const { runTargetErrorSentence } = await import('@piwitests/editor/run-target-view');
    const codes = ['disconnected', 'no-answer', 'answered-status', 'sign-in-timed-out', 'sign-in-expired', 'denied'];
    for (const code of codes as Array<Parameters<typeof runTargetErrorSentence>[0]>) {
      const errorArgs = { status: 502 };
      const error = runTargetErrorSentence(code, errorArgs);
      expect(connectionErrorWords({ error, errorCode: code, errorArgs }), code).toBe(error);
    }
    expect(connectionErrorWords({ error: 'Key revoked by Dana.', errorCode: null, errorArgs: {} })).toBe(
      'Key revoked by Dana.',
    );
  });
});
