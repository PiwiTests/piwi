// Runs the ASP.NET Core backend's unit tests on a coverage build and uploads their coverage as the `unit-back` suite
// of the commit checked out, beside the coverage the Playwright suite records for the same commit. The test host
// writes Piwi's run-level report at exit (PIWI_COVERAGE_OUTPUT), with the span table's lines: the ones the end-to-end
// suite counts. Reads PIWI_DASHBOARD_URL (http://localhost:3000 by default), PIWI_API_KEY and PIWI_PROJECT_NAME
// (sample-app-aspnetcore by default) from the environment or the `.env` file here. Extra arguments go to `piwi coverage upload` (`--dry-run`).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const report = resolve('backends/aspnetcore.Tests/TestResults/piwi-coverage.json');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('dotnet', ['test', 'backends/aspnetcore.Tests', '-p:PiwiCoverage=true'], {
  PIWI_COVERAGE_OUTPUT: report,
  PIWI_COVERAGE_MODE: 'run',
});
run('npx', ['piwi', 'coverage', 'upload', report, '--suite', 'unit-back', ...process.argv.slice(2)], {
  PIWI_DASHBOARD_URL: process.env.PIWI_DASHBOARD_URL ?? 'http://localhost:3000',
  PIWI_PROJECT_NAME: process.env.PIWI_PROJECT_NAME ?? 'sample-app-aspnetcore',
});
