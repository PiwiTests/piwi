import { errorMessage } from '../internal/support/errors.js';
import type { PiwiDashboardOptions } from './options.js';
import { resolveOptions, usedDesktopToken } from '../internal/config/env.js';
import { HttpClient } from '../internal/transport/http-client.js';
import { Logger } from '../internal/support/logger.js';
import { computeInstanceId } from '../internal/support/instance-id.js';
import { detectCi, resolveRunLabel } from '../internal/support/ci.js';
import { resolveShardInfo } from '../internal/support/shard-info.js';
import { resolveScmBranch } from '../internal/collect/metadata-collector.js';
import { isLiveViewKey } from '@piwitests/core/live-view';
import { writeSetupFailure, writeSetupInfo } from '../internal/support/setup-file.js';
import { answeredRunUrl } from '../internal/support/run-url.js';
import { ariaSampleIdentity, clearAriaSampleFile, writeAriaSampleFile } from '../internal/support/aria-sampling.js';
import { isUiMode, isListMode } from '../internal/support/run-mode.js';
import { checkBaseUrls, remoteBrowserNote } from '../internal/support/base-url-check.js';
import { readCommittedManifest, fetchInstrumentationManifest } from '../internal/manifest/collect.js';
import { configDirFromConfig } from '../internal/support/test-paths.js';
import { lookupProjectId, uploadManifest } from '../internal/manifest/run-manifests.js';
import { baseUrlsFromConfig } from '../internal/collect/server-coverage.js';
import { isPiwiReporterModule } from '../internal/support/reporter-entry.js';
import { getReporterVersion } from '../internal/support/reporter-version.js';
import { relayRunLog } from '../internal/support/run-log.js';

/** Whether this process relays its workers' lines to the run's log already. */
let relaying = false;

/**
 * Create a Playwright `globalSetup` function that registers a test run on the
 * Piwi Dashboard server at the start of the run.  An optional `userSetup` is
 * called afterward so existing setup logic is preserved.
 *
 * The server-run ID and a one-time token are written to a temp file so the
 * reporter instance can pick them up during the streaming handshake.
 *
 * With `checkBaseUrl`, every `baseURL` the run's projects use is checked first,
 * and the setup throws, stopping the run before any worker starts, when one
 * does not answer.
 *
 * @param options   Piwi Dashboard options (uses `serverUrl`, `projectName`, …).
 * @param userSetup An existing global setup to chain after the Piwi registration.
 */
export function createGlobalSetup(
  options?: PiwiDashboardOptions,
  userSetup?: (config: any) => any,
): (config: any) => Promise<any> {
  return async function globalSetupFn(config: any) {
    // Piwi's entry in the Playwright config's reporters, which Playwright hands over resolved to a path. Its options
    // (serverUrl / projectName etc. set inline in the reporters array) are visible here without requiring PIWI_* env
    // vars or a separate wrapConfig call.
    const configDir = configDirFromConfig(config);
    const piwiReporter: unknown[] | undefined = Array.isArray(config?.reporter)
      ? config.reporter.find(
          (r: unknown) => Array.isArray(r) && typeof r[0] === 'string' && isPiwiReporterModule(r[0], configDir),
        )
      : undefined;
    const inline = piwiReporter?.[1];
    const inlineReporterOptions: Record<string, any> = inline && typeof inline === 'object' ? inline : {};

    const opts = resolveOptions({ ...inlineReporterOptions, ...options } as Record<string, any>, configDir);
    const logger = new Logger(opts.verbose ?? false);

    // In Playwright's UI mode the reporter never runs to finish a registered
    // run, so registering here would leave orphaned "initializing" runs (one at
    // UI launch, one per manual run). Skip registration but still chain
    // userSetup so the user's own setup keeps working under the UI.
    if (isUiMode()) {
      logger.debug('UI mode detected — skipping run registration.');
      if (userSetup) return userSetup(config);
      return;
    }

    // `playwright test --list` runs globalSetup but executes no tests, so
    // registering here would leave an empty phantom run on the dashboard. Skip
    // registration but still chain userSetup so the user's own setup keeps working.
    if (isListMode()) {
      logger.debug('List mode detected — skipping run registration.');
      if (userSetup) return userSetup(config);
      return;
    }

    // Before the run is registered, so a run stopped here leaves none behind.
    if (opts.checkBaseUrl === true) {
      const checked = await checkBaseUrls(config ?? {});
      for (const target of checked) {
        const note = remoteBrowserNote(target);
        if (note) {
          logger.info(
            `Base URL answered: ${target.url}. ${note} A navigation failure from that browser can mean its machine cannot reach the app, not that the app is down.`,
          );
        } else {
          logger.debug(`Base URL answered: ${target.url}`);
        }
      }
    }

    if (opts.enabled === false || !opts.serverUrl) {
      logger.info('Not enabled — set PIWI_DASHBOARD_URL or serverUrl to enable.');
      if (userSetup) return userSetup(config);
      return;
    }

    if (!piwiReporter) {
      logger.debug('Not reporting — Piwi is not in the Playwright reporters list.');
      if (userSetup) return userSetup(config);
      return;
    }

    const httpClient = new HttpClient(
      opts.serverUrl,
      logger,
      undefined,
      undefined,
      usedDesktopToken() ? (opts.apiKey ?? null) : null,
    );
    // The run registered here is the one the reporter streams into. A run sent in one batch at its end creates its
    // own, so with streaming off nothing is registered: no run waits for a stream that never comes.
    const registers = opts.streaming !== false;
    let registered = false;

    try {
      const auth = await httpClient.resolveAuth(opts);

      if (registers) {
        await registerRun(httpClient, auth, opts, config, logger);
        registered = true;
      }

      // A prior run's ARIA sample set is always cleared first so a stale file
      // never leaks in — even when sampling is off this run.
      if (opts.projectName) clearAriaSampleFile(opts.projectName);

      // Determine what needs the project id before fetching the menu, so a run
      // with neither ARIA sampling nor a manifest makes no extra request.
      const wantsAria = opts.sampleAriaOnPass !== false && !!opts.projectName;
      const committedManifest =
        opts.uploadManifest !== false ? readCommittedManifest(configDirFromConfig(config)) : null;
      const manifestBaseUrls = opts.uploadManifest !== false ? baseUrlsFromConfig(config) : [];
      const wantsManifest =
        opts.uploadManifest !== false && !!opts.projectName && (!!committedManifest || manifestBaseUrls.length > 0);

      let projectId: number | undefined;
      if ((wantsAria || wantsManifest) && opts.projectName) {
        projectId = await lookupProjectId(httpClient, auth, opts.projectName);
      }

      // Ask the server which tests are due a fresh green ARIA sample this run
      // and stash the answer for the worker fixtures. An old server or a failed
      // call leaves no file, and the fixtures then sample nothing.
      if (wantsAria && projectId != null) {
        const sampling = await httpClient.getJSON(`/api/projects/${projectId}/aria-sampling`, auth);
        const tests = Array.isArray(sampling?.tests) ? (sampling.tests as Array<Record<string, unknown>>) : null;
        if (tests) {
          const identities = tests
            .filter((t) => typeof t.filePath === 'string' && typeof t.title === 'string')
            .map((t) => ariaSampleIdentity(t.filePath as string, t.title as string));
          writeAriaSampleFile(opts.projectName!, identities);
          logger.debug(`Green ARIA sampling: ${identities.length} test(s) due a sample.`);
        }
      }

      // Declared surface: upload a committed `piwi.manifest.json` and the
      // `/__piwi/manifest` of each base URL whose app carries an instrumentation
      // header. The other origins the run reaches are the reporter's.
      if (wantsManifest && projectId != null) {
        // The run's branch, so the dashboard tags a route added on a pull-request
        // branch instead of writing it to the default-branch surface.
        const branch = resolveScmBranch(process.env) ?? null;
        if (committedManifest) {
          await uploadManifest(
            httpClient,
            auth,
            projectId,
            { source: 'committed', branch, manifest: committedManifest },
            logger,
          );
        }
        const declared = await Promise.all(manifestBaseUrls.map((url) => fetchInstrumentationManifest(url)));
        for (const manifest of declared) {
          if (manifest) {
            await uploadManifest(httpClient, auth, projectId, { source: 'instrumentation', branch, manifest }, logger);
          }
        }
      }
    } catch (error) {
      logger.warn(`Could not register global setup: ${errorMessage(error)}`);
      // The reporter says why the run has no live view: the instance did not take its registration.
      if (registers && !registered && opts.projectName) writeSetupFailure(opts.projectName, errorMessage(error));
    }

    if (userSetup) return userSetup(config);
  };
}

/**
 * Register the run the reporter will stream into (`/api/test-runs/setup`), and hand its id, setup token and live view
 * key to the reporter's stream through the setup file.
 */
async function registerRun(
  httpClient: HttpClient,
  auth: string | null,
  opts: PiwiDashboardOptions,
  config: any,
  logger: Logger,
): Promise<void> {
  // The shard from Playwright's --shard=1/3, or the one `piwi run --shard` set
  const shard = resolveShardInfo(config);

  const response = await httpClient.postJSON(
    '/api/test-runs/setup',
    {
      projectName: opts.projectName,
      projectDescription: opts.projectDescription,
      environment: opts.environment || null,
      label: opts.label || null,
      keep: opts.keep === true,
      startTime: new Date().toISOString(),
      instanceId: computeInstanceId(opts.projectName!, resolveRunLabel(opts.runLabel, shard !== null)),
      shardIndex: shard?.current,
      shardTotal: shard?.total,
      // The dashboard reads from it whether the run's `/begin` carries its setup token in a header too.
      reporterVersion: getReporterVersion(),
      // A key for the run's live view: the instance hands one out only for a project that turned it on, and the
      // desktop app none. A CI run's workers stream with it at once; a run outside CI sends nothing with it until a
      // person shares the run.
      liveView: true,
    },
    auth,
  );

  if (!response?.runId || !response?.setupToken) {
    throw new Error('the answer to /api/test-runs/setup names no run');
  }
  const liveViewKey = response.liveView?.key;
  const runUrl = answeredRunUrl(response, httpClient.baseUrl, response.runId);
  writeSetupInfo({
    runId: response.runId,
    setupToken: response.setupToken,
    projectName: opts.projectName!,
    ...(isLiveViewKey(liveViewKey) ? { liveViewKey } : {}),
    ...(response.liveView?.refused === 'local' ? { liveViewLocal: true as const } : {}),
    runUrl,
  });
  // The run is on the dashboard from now on, through a long global setup too.
  logger.info(`View live progress: ${runUrl}`);
  // A CI run's workers say in its log when their live view is lost and when it is back, outside any test's output;
  // without the relay's file the run goes on without those lines.
  if (isLiveViewKey(liveViewKey) && detectCi(process.env) && !relaying) {
    try {
      const stopRelay = relayRunLog((line) => logger.info(line));
      relaying = true;
      process.once('exit', stopRelay);
    } catch (error) {
      logger.debug(`Global setup: the live view's lines go to no file (${errorMessage(error)})`);
    }
  }
}
