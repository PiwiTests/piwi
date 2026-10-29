/**
 * Turn a failure into a copy-paste way to reproduce it locally, and a ready-made
 * `git bisect` that finds the commit that broke it.
 *
 * Two pure generators, no I/O: the server gathers the run's commit, Playwright
 * version, browser and the last-green commit and hands them here, so the same
 * recipe renders on the cluster page, the execution page, the Markdown export
 * and the `get_fix_plan` MCP tool without any of them re-deriving it.
 *
 * Every command is cross-platform. git, npm and npx behave the same on every
 * OS, so the bash and PowerShell forms of a step are usually identical; the
 * pair is always returned so a caller can offer both without special-casing.
 * Each part degrades on its own: no commit skips the checkout and says so, an
 * unknown Playwright version drops the pin, and a missing bisect window returns
 * a plain reason instead of a script.
 */
import { buildRetryArgs, type RetryCase } from '#shared/retry-command';
import { isPlainRevision } from '#shared/scm-urls';

// The recipe's values come from the reporter and are pasted into a shell, so each must look like what it names.
const PLAYWRIGHT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const BROWSER_NAME = /^[a-z][\w-]*$/i;

/** One numbered line of the local reproduction, in both shell dialects. */
export interface ReproStep {
  /** Human label for the step ("Check out the failing commit"). */
  step: string;
  /** The command on Linux / macOS. */
  bash: string;
  /** The command on Windows (PowerShell). */
  powershell: string;
}

/** A fact the reproduction needs but cannot express as a command. */
export interface ReproEnv {
  label: string;
  value: string;
}

export interface ReproRecipe {
  /** The reproduction, in order: checkout, install, browser install, run. */
  steps: ReproStep[];
  /** Environment the run declared (environment label, base URL) — informational. */
  env: ReproEnv[];
  /** What could not be pinned, one plain sentence each. */
  notes: string[];
  /** The failing commit, when the run recorded one. */
  commit: string | null;
  /** The run's Playwright version, when recorded. */
  playwrightVersion: string | null;
  /** The browser binary to install (`chromium` / `firefox` / `webkit`). */
  browser: string | null;
  /** The Playwright project the failing tests ran under, when one was recorded. */
  project: string | null;
}

export interface ReproInput {
  /** SHA of the commit the failing run was on. Null skips the checkout step. */
  commit: string | null;
  /** Playwright version the run reported. Null drops the version pin. */
  playwrightVersion: string | null;
  /** Browser binary (`chromium` / `firefox` / `webkit`) to install. */
  browserName: string | null;
  /** Playwright project the failing tests ran under. */
  projectName: string | null;
  /** Environment label the run declared. */
  environment: string | null;
  /** Base URL the run targeted, when known. */
  baseUrl: string | null;
  /** The failing tests, for the exact `playwright test` invocation. */
  cases: RetryCase[];
}

export type BisectResult =
  | { available: false; reason: string }
  | {
      available: true;
      /** Last green commit — the `good` end of the window. */
      good: string;
      /** Failing commit — the `bad` end of the window. */
      bad: string;
      goodShort: string;
      badShort: string;
      /** The whole `git bisect` on Linux / macOS. */
      bash: string;
      /** The whole `git bisect` on Windows (PowerShell). */
      powershell: string;
      /** One line saying what the script does. */
      explanation: string;
    };

export interface BisectInput {
  /** Last green commit (the regression window's `fromSha`). */
  good: string | null;
  /** Failing commit (the regression window's `toSha`). */
  bad: string | null;
  /** The command that proves a commit good (exit 0) or bad (non-zero). */
  verifyCommand: string;
}

/**
 * The first bad commit a bisect found — the identity the desktop shell records
 * on the cluster so it survives reloads and reaches the fix plan. `commitUrl` is
 * derived at read time from the project's SCM provider, so it is not stored.
 */
export interface BisectedCommit {
  sha: string;
  subject: string;
  author: string | null;
  /** ISO date the commit was authored, when git reported one. */
  date: string | null;
  /** Deep link to the commit on the configured SCM host, when one is known. */
  commitUrl: string | null;
}

/**
 * What the desktop shell needs to run a reproduction or drive a bisect against
 * the project's linked folder, and to link/persist the result — computed once by
 * the server alongside the recipe so the Reproduce section never re-derives it.
 * All fields degrade to null; the desktop actions gate on the ones they need.
 */
export interface ReproduceDesktopContext {
  /** The project the failure belongs to — the key for the folder link. */
  projectId: number | null;
  /** The failing tests, structured, for the exact local invocation. */
  cases: RetryCase[];
  /** Browser binary the failure ran on (`chromium` / `firefox` / `webkit`). */
  browserName: string | null;
  /** The failing commit to check out for a reproduction. */
  commit: string | null;
  /** The bisect window's `good` end (last green commit), when known. */
  good: string | null;
  /** The bisect window's `bad` end (failing commit), when known. */
  bad: string | null;
  /** The failure cluster to persist a bisect result on, when the failure has one. */
  clusterId: number | null;
  /** SCM repository URL, for linking a bisected commit to its host. */
  repositoryUrl: string | null;
  /** A bisect result already recorded on the cluster, when one was found. */
  bisectedCommit: BisectedCommit | null;
  /**
   * The Flake Lab arm that reproduced the failing test, when it is one test and
   * an experiment reproduced it: a bisect then runs that arm at each step.
   */
  flakeArm: { testCaseId: number; label: string } | null;
}

/**
 * Build the local reproduction recipe. Always returns a recipe; the parts that
 * cannot be pinned drop out with a note rather than failing.
 */
export function buildReproRecipe(input: ReproInput): ReproRecipe {
  const steps: ReproStep[] = [];
  const notes: string[] = [];

  // 1. Check out the exact commit the run failed on. git is portable, so both
  //    shell forms are the same command.
  if (input.commit && isPlainRevision(input.commit)) {
    const checkout = `git switch --detach ${input.commit}`;
    steps.push({ step: 'Check out the failing commit', bash: checkout, powershell: checkout });
  } else if (input.commit) {
    notes.push('The recorded commit is not a plain revision, so the checkout step is skipped.');
  } else {
    notes.push(
      'No commit was recorded for this run, so the checkout step is skipped — reproduce against your current tree.',
    );
  }

  // 2. Install the project's dependencies from the lockfile at that commit.
  steps.push({ step: 'Install dependencies', bash: 'npm ci', powershell: 'npm ci' });

  // 3. Pin Playwright to the version the run used, so the browsers and the
  //    runner match. Without a recorded version the project's own pin is used.
  if (input.playwrightVersion && PLAYWRIGHT_VERSION.test(input.playwrightVersion)) {
    const pin = `npm install -D @playwright/test@${input.playwrightVersion}`;
    steps.push({ step: "Pin Playwright to the run's version", bash: pin, powershell: pin });
  } else {
    notes.push("The run's Playwright version was not recorded, so the version your project resolves is used.");
  }

  // 4. Install the browser the failure ran on (all browsers when unknown).
  const install =
    input.browserName && BROWSER_NAME.test(input.browserName)
      ? `npx playwright install ${input.browserName}`
      : 'npx playwright install';
  steps.push({ step: 'Install the browser', bash: install, powershell: install });

  // 5. Run exactly the failing test(s) at the failing commit: their file:line
  //    specs and projects, as one command a CI re-run would run, the same on
  //    every shell.
  const testArgs = buildRetryArgs(input.cases);
  const testCmd = testArgs ? `npx playwright test ${testArgs}` : 'npx playwright test';
  steps.push({ step: 'Run the failing test', bash: testCmd, powershell: testCmd });

  const env: ReproEnv[] = [];
  if (input.environment) env.push({ label: 'Environment', value: input.environment });
  if (input.baseUrl) env.push({ label: 'Base URL', value: input.baseUrl });

  return {
    steps,
    env,
    notes,
    commit: input.commit,
    playwrightVersion: input.playwrightVersion,
    browser: input.browserName,
    project: input.projectName,
  };
}

/** Comment prefix — `#` starts a comment in both bash and PowerShell. */
const COMMENT = '#';

/**
 * Assemble a recipe into one copy-paste script for the given shell: each step
 * as a `# label` comment followed by its command.
 */
export function reproScript(recipe: ReproRecipe, shell: 'bash' | 'powershell'): string {
  const lines: string[] = [];
  for (const s of recipe.steps) {
    lines.push(`${COMMENT} ${s.step}`);
    lines.push(shell === 'bash' ? s.bash : s.powershell);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Build the `git bisect` that finds the breaking commit between the last green
 * commit and the failing one, or explain why the window is missing.
 */
export function buildBisectScript(input: BisectInput): BisectResult {
  const { good, bad, verifyCommand } = input;

  if (!bad) {
    return {
      available: false,
      reason:
        'A git bisect needs the failing commit, and the failing run does not record one: the reporter reads it from the Git checkout the tests run in.',
    };
  }
  if (!isPlainRevision(bad) || (good && !isPlainRevision(good))) {
    return {
      available: false,
      reason: 'A recorded commit is not a plain revision, so no bisect is built from it.',
    };
  }
  if (!good) {
    return {
      available: false,
      reason: `A git bisect needs a last-green commit, and no passing run records one yet. With a commit you know was good: git bisect start ${bad.slice(0, 7)} <good commit>.`,
    };
  }
  if (good === bad) {
    return {
      available: false,
      reason:
        'The last passing run tested the same commit, so there is nothing to bisect: what broke it is not in the code.',
    };
  }

  const command = verifyCommand.trim() || 'npx playwright test';
  const goodShort = good.slice(0, 7);
  const badShort = bad.slice(0, 7);

  // git and npx are portable, so the two forms are the same commands. `git
  // bisect run` re-runs the command at each step: exit 0 marks the commit good,
  // any non-zero marks it bad — exactly what a failing `playwright test` does.
  const script = [`git bisect start ${bad} ${good}`, `git bisect run ${command}`, 'git bisect reset'].join('\n');

  return {
    available: true,
    good,
    bad,
    goodShort,
    badShort,
    bash: script,
    powershell: script,
    explanation: `Walks the commits between the last green (${goodShort}) and the failing commit (${badShort}), re-running the test at each step until it names the first commit that broke it — a non-zero exit marks a commit bad. \`git bisect reset\` returns you to where you started.`,
  };
}
