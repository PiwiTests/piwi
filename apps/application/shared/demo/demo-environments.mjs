/**
 * The demo's environment snapshots, as reporters send them: where each seeded run executed. The history tells four
 * stories the dashboard shows: a CI runner image upgrade in the newest runs, a run on a self-hosted runner in
 * `Europe/Paris` with `fr-FR`, a sharded run whose shards ran with different time zones, and a server under test
 * whose clock is 3 s ahead of the runner's.
 */

/** The CI image the newest runs ran on, and the one before it. */
export const DEMO_CI_IMAGES = { newer: 'ubuntu24 20261102.1', older: 'ubuntu24 20261020.1' };

/**
 * A CI runner, as a GitHub-hosted Ubuntu machine reports itself.
 * @param {{ shardIndex?: number | null, newerImage?: boolean, timeZone?: string, host?: string }} [options]
 */
export function demoCiRunner({ shardIndex = null, newerImage = true, timeZone = 'UTC', host = 'fv-az101-12' } = {}) {
  return {
    kind: 'runner',
    v: 1,
    shardIndex,
    timeZone,
    utcOffsetMinutes: timeZone === 'UTC' ? 0 : 60,
    tzVariable: timeZone === 'UTC' ? null : timeZone,
    locale: 'en-US',
    langVariables: 'LANG=C.UTF-8',
    os: 'linux 6.8 · Ubuntu 24.04.1 LTS',
    arch: 'x64',
    nodeVersion: newerImage ? 'v24.11.0' : 'v24.10.0',
    icuVersion: newerImage ? '77.1' : '76.1',
    ciImage: newerImage ? DEMO_CI_IMAGES.newer : DEMO_CI_IMAGES.older,
    container: null,
    cpuModel: 'AMD EPYC 7763 64-Core Processor',
    cores: 4,
    memoryBytes: 16 * 1024 ** 3,
    hostname: host,
  };
}

/** A self-hosted runner in the Paris office, set up with the office's time zone and language. */
export function demoParisRunner() {
  return {
    kind: 'runner',
    v: 1,
    shardIndex: null,
    timeZone: 'Europe/Paris',
    utcOffsetMinutes: 60,
    tzVariable: null,
    locale: 'fr-FR',
    langVariables: 'LANG=fr_FR.UTF-8',
    os: 'linux 6.8 · Debian GNU/Linux 13 (trixie)',
    arch: 'x64',
    nodeVersion: 'v24.11.0',
    icuVersion: '77.1',
    ciImage: null,
    container: null,
    cpuModel: 'Intel(R) Xeon(R) E-2388G',
    cores: 8,
    memoryBytes: 32 * 1024 ** 3,
    hostname: 'paris-runner-02',
  };
}

/**
 * A Chromium page, as the capture fixtures read it.
 * @param {{ project?: string, shardIndex?: number | null, newer?: boolean, timeZone?: string, locale?: string }} [options]
 */
export function demoBrowser({
  project = 'chromium',
  shardIndex = null,
  newer = true,
  timeZone = 'UTC',
  locale = 'en-US',
} = {}) {
  const french = locale.startsWith('fr');
  return {
    kind: 'browser',
    v: 1,
    shardIndex,
    project,
    browserName: 'chromium',
    browserVersion: newer ? '141.0.7390.37' : '140.0.7339.16',
    timeZone,
    locale,
    languages: french ? 'fr-FR, fr' : 'en-US',
    formatSample: french ? '1 234,5 · 02/01/2026 04:04:05' : '1,234.5 · 1/2/2026, 3:04:05 AM',
    prefersColorScheme: 'light',
    prefersReducedMotion: 'no-preference',
    screen: '1280×720',
    devicePixelRatio: 1,
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/${newer ? '141.0.7390.37' : '140.0.7339.16'} Safari/537.36`,
    headless: true,
  };
}

/**
 * The application under test, a Nitro server, as `/__piwi/environment` answers. Its start and read times are left
 * out: the demo rebases its dates as it loads, and a time inside the JSON would stay at the generation's.
 * @param {{ origin: string, clockOffsetMs?: number, restarted?: boolean }} options
 */
export function demoServer({ origin, clockOffsetMs = 12, restarted = false }) {
  return {
    kind: 'server',
    v: 1,
    origin,
    runtime: 'Node.js v24.11.0',
    os: 'linux 6.8.0-1017-azure',
    arch: 'x64',
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
    locale: 'en-US',
    globalization: 'icu 77.1 full',
    environmentName: 'production',
    appVersion: null,
    hostname: 'checkout-api-7f9c',
    instance: 'a1b2c3d4',
    startedAt: null,
    fetchedAt: null,
    clockOffsetMs,
    clockOffsetErrorMs: 4,
    restarted,
  };
}
