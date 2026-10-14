/**
 * The backends that serve the sample app. Each one serves the same pages (`web/`) and the same API on the same port,
 * with its own Piwi integration; one runs at a time. `npm run test:<backend>` picks one by the script's name, which
 * works the same in every shell; `SAMPLE_BACKEND` picks one for `npx playwright test`; ASP.NET Core is the default.
 * The Playwright config starts the backend picked, and a spec that needs a feature of the integration skips on a
 * backend without it.
 */

/** Where every backend serves the app. */
export const PORT = 4173;
export const BASE_URL = `http://localhost:${PORT}`;

/** The secret each backend verifies server probes with (`X-Piwi-Probe`), as its launch settings set it. */
export const PROBE_SECRET = 'piwi-sample-probe-secret';

/** What a backend's Piwi integration provides. */
export interface BackendFeatures {
  /** The Warning and Error entries a request logs, on its response's `X-Piwi-Logs` header. */
  backendLogs: boolean;
  /** The routes the backend declares, served at `/__piwi/manifest`. */
  routeManifest: boolean;
  /** The server's spans on each response's `X-Piwi-Trace` header. */
  serverSpans: boolean;
  /** A signed fault (`X-Piwi-Probe`) applied inside the server. */
  serverProbes: boolean;
  /** Per-test server coverage from a coverage build: `X-Piwi-Coverage` and `/__piwi/coverage/*`. */
  serverCoverage: boolean;
}

export interface Backend {
  /** The name `SAMPLE_BACKEND` and the scripts use, and the suffix of the dashboard project. */
  name: string;
  label: string;
  /** The command that builds and starts it on {@link PORT}, run from `cwd` (relative to this folder). */
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** How long its first start may take, building included, in ms. */
  startTimeout: number;
  features: BackendFeatures;
}

export const BACKENDS = {
  aspnetcore: {
    name: 'aspnetcore',
    label: 'ASP.NET Core',
    // A coverage build. `dotnet run` takes the address, the Development environment and the probe settings from
    // backends/aspnetcore/Properties/launchSettings.json.
    command: 'dotnet run --project backends/aspnetcore -p:PiwiCoverage=true',
    startTimeout: 300_000,
    features: { backendLogs: true, routeManifest: true, serverSpans: false, serverProbes: true, serverCoverage: true },
  },
} satisfies Record<string, Backend>;

const fromScript = /^test:(.+)$/.exec(process.env.npm_lifecycle_event ?? '')?.[1];
const picked = fromScript ?? process.env.SAMPLE_BACKEND ?? 'aspnetcore';
if (!(picked in BACKENDS)) {
  throw new Error(`No backend named ${picked}: pick one of ${Object.keys(BACKENDS).join(', ')}.`);
}

/** The backend this run tests. */
export const backend: Backend = BACKENDS[picked as keyof typeof BACKENDS];

/** The reason a spec skips on a backend without `feature`. */
export const unsupported = (feature: keyof BackendFeatures) =>
  `the ${backend.label} integration does not provide ${feature}`;
