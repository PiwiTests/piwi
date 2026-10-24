/**
 * Catalog of MCP **prompts** this server exposes — the slash-command-style
 * entries an MCP client offers the user (Claude Code, Cursor, Copilot, …).
 *
 * Only the catalog (name, description, arguments) lives here, shared so the
 * server route and the in-app MCP setup page can render the same list — the
 * same split `mcp-tools.ts` uses for tools. The message text is built
 * server-side in `server/utils/mcp/prompts.ts`, where it can be filled in with
 * this dashboard's real URL, whether authentication is required, and the
 * projects that already exist.
 *
 * Every workflow skill `piwi skills add` installs is also a prompt, named after
 * the skill: its text is the `SKILL.md` bundled into this build, so a client
 * that cannot read skill files gets the same workflow in the version of the
 * server it talks to. A description here is the skill's own (a unit test
 * compares them).
 */

export interface McpPromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPromptDef {
  name: string;
  description: string;
  /** For a workflow skill served as a prompt: the skill's directory under `templates/skills/`. */
  skill?: string;
  // `readonly` so the catalog can be declared `as const` (needed to derive the
  // `McpPromptName` union) while still satisfying this type.
  arguments?: readonly McpPromptArg[];
}

/** The argument every workflow prompt takes. */
const FOCUS_ARG = {
  name: 'focus',
  description: 'What to work on, when known: a run, a cluster, a test, a gap or a bug report (an id or a URL).',
  required: false,
} as const;

export const MCP_PROMPT_DEFS = [
  {
    name: 'setup_piwi',
    description:
      "Set up the current Playwright project to report to this Piwi Dashboard: install the reporter, wrap the config, add the capture fixtures, and verify a run lands. Server-aware — fills in this dashboard's URL, whether authentication is required, and the projects that already exist.",
    arguments: [
      {
        name: 'projectName',
        description: 'Name to report runs under. Omit to reuse an existing project or derive one from the repository.',
        required: false,
      },
    ],
  },
  {
    name: 'investigate_failure',
    skill: 'investigate-failure',
    description:
      'Investigate a failed test run recorded in Piwi Dashboard and propose a fix grounded in its evidence — error, steps, console, network, locator suggestion, and the diff since the last green run. Use when the user asks "why did the last run fail", "what broke in CI", "diagnose this failure", or points at a Piwi run/cluster.',
    arguments: [FOCUS_ARG],
  },
  {
    name: 'apply_locator_healing',
    skill: 'apply-locator-healing',
    description:
      'Replace brittle Playwright locators with the healed selector Piwi suggests after a failing run, then re-run to confirm. Use when a test fails because a selector no longer matches, when the user asks to "fix the broken locator", "apply Piwi\'s suggestion", or "heal the selector".',
    arguments: [FOCUS_ARG],
  },
  {
    name: 'stabilize_flaky_tests',
    skill: 'stabilize-flaky-tests',
    description:
      'Find the flakiest Playwright tests from Piwi\'s flaky analysis, make each one fail on demand with Piwi\'s Flake Lab, fix what the reproducing condition points at, and prove the fix under that same condition. Use when the user asks to "fix flaky tests", "reduce flakiness", "why is this test flaky", or wants to clean up an unreliable suite.',
    arguments: [FOCUS_ARG],
  },
  {
    name: 'run_the_right_tests',
    skill: 'run-the-right-tests',
    description:
      'Pick and run the right subset of Playwright tests using Piwi\'s data-driven selections and the tests a change impacts, instead of always running the whole suite. Use when the user asks to "run smoke tests", "run the right tests", "just run what\'s relevant", "run the tests my change affects", "verify this fix", or wants a fast, targeted test loop rather than the full run.',
    arguments: [FOCUS_ARG],
  },
  {
    name: 'write_the_missing_test',
    skill: 'write-the-missing-test',
    description:
      'Write a test that does not exist yet, chosen from Piwi\'s scenario gaps — the routes, pages, controls and error paths the suite never exercises, or passes over without noticing. Use when the user asks to "close a test gap", "cover what\'s missing", "write the test we\'re missing", "add coverage for this change", or wants the next most valuable test rather than more of the same.',
    arguments: [FOCUS_ARG],
  },
  {
    name: 'fix_a_reported_bug',
    skill: 'fix-a-reported-bug',
    description:
      'Fix a bug someone reported from Piwi Picker, starting from its failing test. Use when the user names a Piwi bug report ("bug #37"), asks to "fix the reported bug", "reproduce this bug report", or pastes a link to /bug-reports/<id>.',
    arguments: [FOCUS_ARG],
  },
] as const satisfies readonly McpPromptDef[];

export type McpPromptName = (typeof MCP_PROMPT_DEFS)[number]['name'];

/** The workflow skills served as prompts, by prompt name. */
export const SKILL_PROMPTS: ReadonlyMap<string, string> = new Map(
  MCP_PROMPT_DEFS.flatMap((p) => ('skill' in p ? [[p.name, p.skill] as const] : [])),
);
