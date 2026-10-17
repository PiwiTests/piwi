// Runs the ASP.NET Core backend's unit tests on a coverage build and uploads their coverage as the `unit-back` suite
// of the commit checked out, beside the coverage the Playwright suite records for the same commit. Each test host
// writes Piwi's run-level report at exit into the directory PIWI_COVERAGE_OUTPUT names, one file per host, with the
// span table's lines: the ones the end-to-end suite counts. Reads PIWI_DASHBOARD_URL (http://localhost:3000 by
// default), PIWI_API_KEY and PIWI_PROJECT_NAME (sample-app-aspnetcore by default) from the environment or the `.env`
// file here. Extra arguments go to `piwi coverage upload` (`--dry-run`).
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const reports = resolve('backends/aspnetcore.Tests/TestResults/piwi-coverage');

/** Runs a command without a shell, so each argument reaches it whole; exits on a failure. */
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The reporter's `piwi` command, run with this Node: the one this folder installs, else, inside the Piwi repository,
// its workspace.
const require = createRequire(import.meta.url);
let piwi;
try {
  const manifest = require.resolve('@piwitests/reporter/package.json');
  piwi = join(dirname(manifest), require(manifest).bin.piwi);
} catch {
  console.error('@piwitests/reporter is not installed: run `npm install` here first.');
  process.exit(1);
}
if (spawnSync(process.execPath, [piwi, 'coverage', 'upload', '--help'], { stdio: 'ignore' }).status !== 0) {
  console.error(
    'The installed @piwitests/reporter has no `piwi coverage upload`: it needs 0.55.0 or later. Inside the Piwi ' +
      'repository, build the workspace one with `npm run reporter:build` in packages/reporter.',
  );
  process.exit(1);
}

// A report left by an earlier run would be uploaded for this commit.
rmSync(reports, { recursive: true, force: true });
run('dotnet', ['test', 'backends/aspnetcore.Tests', '-p:PiwiCoverage=true'], {
  // A directory: a report per test host, named after its test project.
  PIWI_COVERAGE_OUTPUT: reports + '/',
  PIWI_COVERAGE_MODE: 'run',
  // The time VSTest gives a test host to exit once its tests end, writing its report; 100 ms by default.
  VSTEST_TESTHOST_SHUTDOWN_TIMEOUT: '30000',
});
const written = existsSync(reports) ? readdirSync(reports).filter((name) => name.endsWith('.json')) : [];
if (written.length === 0) {
  console.error(
    `The unit tests wrote no coverage report in ${reports}: none of them ran the backend's code, or a test host ` +
      'could not write its report (its standard error says why).',
  );
  process.exit(1);
}
run(process.execPath, [piwi, 'coverage', 'upload', `${reports}/*.json`, '--suite', 'unit-back', ...process.argv.slice(2)], {
  PIWI_DASHBOARD_URL: process.env.PIWI_DASHBOARD_URL ?? 'http://localhost:3000',
  PIWI_PROJECT_NAME: process.env.PIWI_PROJECT_NAME ?? 'sample-app-aspnetcore',
});
