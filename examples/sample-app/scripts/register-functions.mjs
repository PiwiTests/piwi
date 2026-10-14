// Registers the shop's page-object methods (scripts/shop-functions.json) in the project's test functions catalog on
// the Piwi instance, so a recording collapses the steps they drive into a call: `await loginPage.login(…)`.
// Reads PIWI_DASHBOARD_URL, PIWI_API_KEY and PIWI_PROJECT_NAME from the environment or the `.env` file here; the
// project defaults to the one the suite reports to, sample-app-<backend> (SAMPLE_BACKEND, aspnetcore by default). Run
// it again after changing a page object: an entry already registered is updated.
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const server = (process.env.PIWI_DASHBOARD_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const projectName = process.env.PIWI_PROJECT_NAME ?? `sample-app-${process.env.SAMPLE_BACKEND ?? 'aspnetcore'}`;
const headers = {
  'Content-Type': 'application/json',
  ...(process.env.PIWI_API_KEY ? { 'X-API-Key': process.env.PIWI_API_KEY } : {}),
};

async function call(method, path, body) {
  const response = await fetch(`${server}${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

const { items: projects = [] } = await call('GET', '/api/projects/menu');
const project = projects.find((p) => p.name === projectName);
if (!project) {
  console.error(`No project named ${projectName} on ${server}: run \`npm test\` once, so its first run creates it.`);
  process.exit(1);
}
const { items: registered = [] } = await call('GET', `/api/projects/${project.id}/test-functions`);
for (const entry of JSON.parse(readFileSync(new URL('./shop-functions.json', import.meta.url), 'utf8'))) {
  const existing = registered.find((f) => f.name === entry.name && f.module === entry.module);
  if (existing) await call('PATCH', `/api/test-functions/${existing.id}`, entry);
  else await call('POST', `/api/projects/${project.id}/test-functions`, { ...entry, source: 'manual' });
  console.log(`${existing ? 'Updated' : 'Registered'} ${entry.receiver}.${entry.name} (${entry.module})`);
}
console.log(`The catalog: ${server}/projects/${project.id}/test-functions`);
