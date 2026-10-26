// Sets the sample project's coverage scope and areas. The scope keeps coverage to the source files of the sample's web
// pages and of the backend it runs: inside the Piwi repository every other tracked file, the other backend and the
// sample's pages, settings and READMEs would count as files without coverage data. The two areas, `front` (the
// pages, scripts and stylesheet under web/) and `back` (the backends), are counted apart on the coverage page, in the
// trend and in the pull-request comment. Run it once before the first `npm run coverage:unit`. Reads PIWI_DASHBOARD_URL,
// PIWI_API_KEY and PIWI_PROJECT_NAME from the environment or the `.env` file here; the project defaults to
// sample-app-<backend> (SAMPLE_BACKEND, aspnetcore by default). Run it again any time: it sets the same values.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const server = (process.env.PIWI_DASHBOARD_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const backend = process.env.SAMPLE_BACKEND ?? 'aspnetcore';
const projectName = process.env.PIWI_PROJECT_NAME ?? `sample-app-${backend}`;
const headers = {
  'Content-Type': 'application/json',
  ...(process.env.PIWI_API_KEY ? { 'X-API-Key': process.env.PIWI_API_KEY } : {}),
};

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(`${server}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    console.error(`Could not reach ${server}: ${error.cause?.message ?? error.message}`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
    process.exit(1);
  }
  return response.json();
}

const { items: projects = [] } = await call('GET', '/api/projects/menu');
const project = projects.find((p) => p.name === projectName);
if (!project) {
  console.error(`No project named ${projectName} on ${server}: run \`npm test\` once, so its first run creates it.`);
  process.exit(1);
}
// The default excludes stay: the unit tests' project (`*.Tests/`), build output and generated sources.
const coverageScope = {
  include: [
    'examples/sample-app/web/**/*.js',
    'examples/sample-app/web/**/*.css',
    `examples/sample-app/backends/${backend}/**/*.${backend === 'aspnetcore' ? 'cs' : 'ts'}`,
  ],
  exclude: ['*.test.*', '*.spec.*', 'tests/', 'test/', '__tests__/', '*Tests/', '*.Tests/', 'obj/', 'bin/', 'node_modules/', '*.g.cs', '*.Designer.cs', '*.generated.*'],
};
const coverageAreas = [
  { name: 'front', include: ['examples/sample-app/web/'] },
  { name: 'back', include: ['examples/sample-app/backends/'] },
];
await call('PATCH', `/api/projects/${project.id}`, { coverageScope, coverageAreas });
console.log(`${projectName}: coverage kept to the sample's sources, areas ${coverageAreas.map((a) => a.name).join(' and ')} set.`);
