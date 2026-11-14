// Runs every variant of a benchmark in interleaved rounds and records each run's measurements and profile.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { measure, memoryMetric } from './measure.mjs';

const REPORTER = fileURLToPath(new URL('./profile-reporter.mjs', import.meta.url));

const DEFAULTS = {
  command: ['npx', 'playwright', 'test'],
  runs: 5,
  warmup: 1,
  pauseMs: 2000,
  sampleMs: 200,
  clean: ['test-results'],
  artifacts: ['test-results'],
  injectReporter: true,
  prepare: [],
  env: {},
};

/** Loads a benchmark config and fills in its defaults. Relative paths resolve against the config's folder. */
export async function loadConfig(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`No benchmark config at ${path}`);
  const module = await import(pathToFileURL(path).href);
  const config = { ...DEFAULTS, ...(module.default ?? module) };
  config.cwd = resolve(dirname(path), config.cwd ?? '.');
  if (!Array.isArray(config.variants) || !config.variants.length) throw new Error('The config lists no variants');
  const names = new Set();
  for (const variant of config.variants) {
    if (!variant.name) throw new Error('Every variant needs a name');
    if (names.has(variant.name)) throw new Error(`Two variants are named "${variant.name}"`);
    names.add(variant.name);
  }
  return config;
}

/**
 * The order variants run in each round: rotated by one every round and reversed every other round, so no variant
 * always runs first, or always right after the same neighbor.
 */
export function schedule(variantCount, rounds) {
  const order = [];
  for (let round = 0; round < rounds; round++) {
    const rotated = Array.from({ length: variantCount }, (_, i) => (i + round) % variantCount);
    order.push(round % 2 ? rotated.reverse() : rotated);
  }
  return order;
}

function sizeOf(path) {
  if (!existsSync(path)) return 0;
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, entry) => total + sizeOf(join(path, entry)), 0);
}

function runPlain(argv, cwd, env) {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`Preparation step failed: ${argv.join(' ')}`);
}

function format(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Runs the benchmark and writes `results.json` to `outDir` after every run.
 * @param {object} config a loaded config
 * @param {{ outDir: string, only?: string[], log?: (line: string) => void }} options
 */
export async function runBenchmark(config, { outDir, only, log = console.log }) {
  const variants = only?.length ? config.variants.filter((variant) => only.includes(variant.name)) : config.variants;
  if (!variants.length) throw new Error(`No variant is named ${only.join(', ')}`);
  mkdirSync(join(outDir, 'logs'), { recursive: true });
  mkdirSync(join(outDir, 'profiles'), { recursive: true });

  const baseEnv = { ...process.env, ...config.env };
  for (const step of config.prepare) {
    log(`prepare: ${step.join(' ')}`);
    runPlain(step, config.cwd, baseEnv);
  }

  const results = {
    tool: 'suitebench',
    startedAt: new Date().toISOString(),
    machine: machineInfo(),
    memoryMetric,
    config: { command: config.command, runs: config.runs, warmup: config.warmup, cwd: config.cwd },
    variants: variants.map((variant) => ({ name: variant.name, description: variant.description ?? '', env: variant.env ?? {}, args: variant.args ?? [] })),
    runs: [],
  };
  const rounds = schedule(variants.length, config.warmup + config.runs);
  const total = rounds.flat().length;
  let index = 0;
  for (const [round, order] of rounds.entries()) {
    const warmup = round < config.warmup;
    for (const variantIndex of order) {
      index++;
      const variant = variants[variantIndex];
      for (const path of [...config.clean, ...(variant.remove ?? [])]) rmSync(resolve(config.cwd, path), { recursive: true, force: true });
      const label = `${warmup ? 'w' : 'r'}${warmup ? round + 1 : round - config.warmup + 1}-${variant.name}`;
      const profileFile = join(outDir, 'profiles', `${label}.json`);
      const [command, ...args] = config.command;
      const reporterArgs = config.injectReporter ? [`--reporter=${REPORTER}`] : [];
      const measured = await measure({
        command,
        args: [...args, ...(variant.args ?? []), ...reporterArgs],
        cwd: config.cwd,
        env: { ...baseEnv, ...variant.env, SUITEBENCH_PROFILE: profileFile },
        logFile: join(outDir, 'logs', `${label}.log`),
        sampleMs: config.sampleMs,
      });
      const artifactBytes = config.artifacts.reduce((sum, path) => sum + sizeOf(resolve(config.cwd, path)), 0);
      const profile = existsSync(profileFile) ? JSON.parse(readFileSync(profileFile, 'utf8')) : undefined;
      const run = {
        variant: variant.name,
        round: warmup ? -1 : round - config.warmup,
        warmup,
        ...measured,
        artifactBytes,
        counts: profile?.counts,
        retries: profile?.retries,
        categories: profile?.categories,
        testTimeMs: profile?.testTimeMs,
      };
      results.runs.push(run);
      writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
      const outcome = profile
        ? `${profile.counts.expected} passed${profile.counts.unexpected ? `, ${profile.counts.unexpected} FAILED` : ''}${profile.counts.flaky ? `, ${profile.counts.flaky} flaky` : ''}`
        : `exit ${measured.exitCode}, no profile`;
      log(
        `[${String(index).padStart(String(total).length)}/${total}] ${warmup ? 'warm-up' : `round ${round - config.warmup + 1}`} · ${variant.name.padEnd(18)} ` +
          `${format(measured.wallMs)} wall` +
          (measured.cpuMs !== undefined ? ` · ${format(measured.cpuMs)} CPU` : '') +
          (measured.peakMemoryMb !== undefined ? ` · ${Math.round(measured.peakMemoryMb)} MiB` : '') +
          ` · ${outcome}`,
      );
      if (index < total && config.pauseMs) await new Promise((done) => setTimeout(done, config.pauseMs));
    }
  }
  results.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  return results;
}

function machineInfo() {
  const info = { platform: process.platform, arch: process.arch, node: process.version };
  try {
    const os = process.getBuiltinModule('node:os');
    info.cpus = os.cpus().length;
    info.cpuModel = os.cpus()[0]?.model;
    info.memoryGb = Math.round(os.totalmem() / 1024 ** 3);
  } catch {
    // Older Node versions have no getBuiltinModule; the platform fields are enough.
  }
  return info;
}
