import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnPlaywright = vi.fn(async () => 0);
vi.mock('../src/internal/support/playwright-spawn.js', () => ({ spawnPlaywright }));

const { runRerun } = await import('../src/cli/rerun.js');

describe('piwi rerun', () => {
  let errors: string[];
  beforeEach(() => {
    spawnPlaywright.mockClear();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs playwright test with the words the dashboard quoted, then its own arguments', async () => {
    const env = { PIWI_RERUN_ARGS: '"tests/a b.spec.ts:2" "tests/$x.spec.ts" --project="mobile safari"' };
    expect(await runRerun(['--workers=1'], env)).toBe(0);
    expect(spawnPlaywright).toHaveBeenCalledWith(
      ['tests/a b.spec.ts:2', 'tests/$x.spec.ts', '--project=mobile safari', '--workers=1'],
      env,
      { command: 'piwi rerun' },
    );
  });

  it("exits with Playwright's code", async () => {
    spawnPlaywright.mockResolvedValueOnce(1);
    expect(await runRerun([], { PIWI_RERUN_ARGS: '"tests/a.spec.ts"' })).toBe(1);
  });

  it('runs the whole suite when the variable is set and empty', async () => {
    expect(await runRerun([], { PIWI_RERUN_ARGS: '' })).toBe(0);
    expect(spawnPlaywright).toHaveBeenCalledWith([], { PIWI_RERUN_ARGS: '' }, { command: 'piwi rerun' });
  });

  it('fails and names the variable when it is unset', async () => {
    expect(await runRerun([], {})).toBe(2);
    expect(spawnPlaywright).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/PIWI_RERUN_ARGS is not set/);
  });

  it('fails on a quote left open', async () => {
    expect(await runRerun([], { PIWI_RERUN_ARGS: '"tests/a.spec.ts' })).toBe(2);
    expect(spawnPlaywright).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/not closed/);
  });

  it('prints its usage', async () => {
    expect(await runRerun(['--help'], {})).toBe(0);
    expect(spawnPlaywright).not.toHaveBeenCalled();
  });
});
