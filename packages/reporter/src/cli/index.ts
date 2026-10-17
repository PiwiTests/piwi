#!/usr/bin/env node
/**
 * `piwi` — the reporter package's command-line entry point.
 *
 * The reporter's job is to get results into the dashboard during
 * `playwright test`; the CLI covers the things that happen around a run:
 * setting a project up in the first place (`init`, `skills`) and acting on the
 * dashboard's history once a run has landed (`gate`, `report`), checking a
 * change against it before it runs (`preflight`), and reproducing a flaky
 * test under the conditions its history points at (`flake`).
 */
import { runAi } from './ai.js';
import { runBug } from './bug.js';
import { runCodegen } from './codegen.js';
import { runCoverage } from './coverage.js';
import { runFlake } from './flake.js';
import { runGate } from './gate.js';
import { runInit } from './init.js';
import { runSelect, runRun } from './select.js';
import { runPreflight } from './preflight.js';
import { runProbe } from './probe.js';
import { runQualityReport } from './quality-report.js';
import { findTemplatesDir, runSkills } from './skills.js';

const USAGE = `
piwi — companion commands for the Piwi Dashboard reporter

Usage:
  npx @piwitests/reporter <command> [options]

Commands:
  init      Wire a Playwright project up to a Piwi Dashboard
  skills    Install the Piwi agent skills into this project
  gate      Fail a CI job on the dashboard's analysis of a run
  report    Print a quality report (Markdown, PDF, HTML, CSV or JSON)
  coverage  Upload a unit-test (or other) coverage report of a commit (coverage upload)
  select    Print the Playwright args for a saved test selection
  run       Run a saved test selection with playwright test
  probe     Run the dashboard's probe plan and record what the suite noticed
  flake     Make a flaky test fail on demand under its suspects' conditions, then verify the fix
  ai        Manage committed natural-language AI-step artifacts
  codegen   Turn a steps file (a Piwi Picker recording) into a Playwright spec
  preflight List the test locators your uncommitted change breaks, and fix them
  bug       Write a bug report's failing test into the project and run it once

Run \`npx @piwitests/reporter <command> --help\` for a command's options.
(The published package is @piwitests/reporter; its command is piwi. Invoke it
through the package name so npx resolves this package, not an unrelated "piwi".)
`.trim();

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'init':
      return runInit(rest);
    case 'skills':
      return runSkills(rest, findTemplatesDir(__dirname));
    case 'gate':
      return runGate(rest);
    case 'report':
      return runQualityReport(rest);
    case 'coverage':
      return runCoverage(rest);
    case 'select':
      return runSelect(rest);
    case 'run':
      return runRun(rest);
    case 'probe':
      return runProbe(rest);
    case 'flake':
      return runFlake(rest);
    case 'ai':
      return runAi(rest);
    case 'codegen':
      return runCodegen(rest);
    case 'preflight':
      return runPreflight(rest);
    case 'bug':
      return runBug(rest);
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`piwi: unknown command "${command}"\n`);
      console.error(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`piwi: ${(e as Error).message}`);
    process.exitCode = 2;
  });
