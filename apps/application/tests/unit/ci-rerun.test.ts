import { describe, test, expect } from 'vitest';
import { resolveCiRerunSettings, hasRerunTarget } from '#shared/ci-rerun';
import { buildRerunCommand, buildRetryArgs } from '#shared/retry-command';

describe('resolveCiRerunSettings', () => {
  test('defaults to disabled with no targets', () => {
    expect(resolveCiRerunSettings(null)).toEqual({ enabled: false });
    expect(resolveCiRerunSettings({})).toEqual({ enabled: false });
  });

  test('keeps a fully specified target and trims values', () => {
    const resolved = resolveCiRerunSettings({
      enabled: true,
      github: { workflow: ' e2e.yml ', ref: 'main', inputName: 'args' },
    });
    expect(resolved).toEqual({ enabled: true, github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' } });
  });

  test('drops an incomplete target rather than storing a half-configured one', () => {
    const resolved = resolveCiRerunSettings({
      enabled: true,
      github: { workflow: 'e2e.yml', ref: '', inputName: 'args' },
      gitlab: { ref: 'main', variableName: 'PW_ARGS' },
    });
    expect(resolved.github).toBeUndefined();
    expect(resolved.gitlab).toEqual({ ref: 'main', variableName: 'PW_ARGS' });
  });
});

describe('hasRerunTarget', () => {
  const settings = resolveCiRerunSettings({
    enabled: true,
    gitlab: { ref: 'main', variableName: 'PW_ARGS' },
  });

  test('true only when enabled and a target exists for the provider', () => {
    expect(hasRerunTarget(settings, 'gitlab')).toBe(true);
    expect(hasRerunTarget(settings, 'github')).toBe(false);
  });

  test('false when disabled even if a target is present', () => {
    expect(hasRerunTarget({ ...settings, enabled: false }, 'gitlab')).toBe(false);
    expect(hasRerunTarget(null, 'gitlab')).toBe(false);
  });
});

describe('buildRerunCommand', () => {
  test('names the files, the titles and the projects, so a moved line still matches', () => {
    expect(
      buildRerunCommand([
        { filePath: 'a.spec.ts', title: 'pays', line: 1, projectName: 'chromium' },
        { filePath: 'b.spec.ts', title: 'refunds', line: 2, projectName: 'firefox' },
      ]),
    ).toBe('npx playwright test "a.spec.ts" "b.spec.ts" -g "pays|refunds" --project="chromium" --project="firefox"');
  });

  test('runs every project when one name cannot be quoted for every shell', () => {
    expect(
      buildRerunCommand([
        { filePath: 'a.spec.ts', title: 'a', line: 1, projectName: 'chromium' },
        { filePath: 'b.spec.ts', title: 'b', line: 2, projectName: 'Edge 100%' },
      ]),
    ).toBe('npx playwright test "a.spec.ts" "b.spec.ts" -g "a|b"');
  });

  test('drops the titles when they would make the command too long', () => {
    const cases = Array.from({ length: 200 }, (_, i) => ({
      filePath: 'tests/long.spec.ts',
      title: `a long title for the test number ${i}`,
      line: i + 1,
      projectName: null,
    }));
    expect(buildRerunCommand(cases)).toBe('npx playwright test "tests/long.spec.ts"');
  });

  test('never passes a spec that would be read as an option', () => {
    expect(buildRerunCommand([{ filePath: '-u', title: 't', line: null, projectName: null }])).toBe(
      'npx playwright test -g "t"',
    );
  });

  test('runs the whole suite without cases', () => {
    expect(buildRerunCommand([])).toBe('npx playwright test');
  });
});

describe('buildRetryArgs', () => {
  test('emits file:line specs and a shared --project, without the runner prefix', () => {
    const args = buildRetryArgs([
      { filePath: 'tests/checkout.spec.ts', title: 'pays', line: 12, projectName: 'chromium' },
      { filePath: 'tests/checkout.spec.ts', title: 'refunds', line: 40, projectName: 'chromium' },
    ]);
    expect(args).toBe('"tests/checkout.spec.ts:12" "tests/checkout.spec.ts:40" --project="chromium"');
  });

  test('names each project when the cases span more than one', () => {
    const args = buildRetryArgs([
      { filePath: 'a.spec.ts', title: 'a', line: 1, projectName: 'chromium' },
      { filePath: 'b.spec.ts', title: 'b', line: 2, projectName: 'firefox' },
    ]);
    expect(args).toBe('"a.spec.ts:1" "b.spec.ts:2" --project="chromium" --project="firefox"');
  });

  test('never passes a spec that would be read as an option', () => {
    expect(
      buildRetryArgs([
        { filePath: '-u', title: 'u', line: null, projectName: null },
        { filePath: 'ok.spec.ts', title: 'ok', line: 3, projectName: null },
      ]),
    ).toBe('"ok.spec.ts:3"');
  });

  test('names a file without a line once', () => {
    const args = buildRetryArgs([
      { filePath: 'tests/x.spec.ts', title: 'x', line: null, projectName: null },
      { filePath: 'tests/x.spec.ts', title: 'y', line: null, projectName: null },
    ]);
    expect(args).toBe('"tests/x.spec.ts"');
  });

  test('falls back to the file path when a case has no line', () => {
    const args = buildRetryArgs([{ filePath: 'tests/x.spec.ts', title: 'x', line: null, projectName: null }]);
    expect(args).toBe('"tests/x.spec.ts"');
  });

  test('normalizes Windows separators', () => {
    const args = buildRetryArgs([{ filePath: 'tests\\win.spec.ts', title: 'w', line: 5, projectName: null }]);
    expect(args).toBe('"tests/win.spec.ts:5"');
  });
});
