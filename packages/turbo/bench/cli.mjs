#!/usr/bin/env node
// The benchmark CLI: compare configurations of a Playwright suite by running them interleaved, several times, and
// reading the differences with their noise.
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadConfig, prepare, runBenchmark, selectVariants } from './src/run.mjs';
import { formatMarkdown, summarize } from './src/report.mjs';
import { measure } from './src/measure.mjs';
import { formatProfile } from './src/profile-reporter.mjs';

const HELP = `Usage:
  node bench/cli.mjs run [--config bench.config.mjs] [--runs N] [--warmup N] [--only a,b] [--out dir]
      Runs every variant in interleaved rounds and writes results.json and summary.md.
  node bench/cli.mjs profile [--config bench.config.mjs] [--variant name]
      Runs one variant once and prints where its test time went.
  node bench/cli.mjs report <results.json> [--min-effect 0.02]
      Prints the comparison of recorded runs again.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: 'bench.config.mjs' },
    runs: { type: 'string' },
    warmup: { type: 'string' },
    only: { type: 'string' },
    out: { type: 'string' },
    variant: { type: 'string' },
    'min-effect': { type: 'string', default: '0.02' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...rest] = positionals;
const minimumEffect = Number(values['min-effect']);

/** A count from the command line: a whole number, at least `least`. */
function count(name, least) {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < least) throw new Error(`--${name} takes a whole number from ${least} up`);
  return parsed;
}

try {
  if (values.help || !command) {
    console.log(HELP);
  } else if (command === 'run') {
    const config = await loadConfig(values.config);
    config.runs = count('runs', 1) ?? config.runs;
    config.warmup = count('warmup', 0) ?? config.warmup;
    const only = values.only?.split(',').map((name) => name.trim());
    const selected = selectVariants(config, only).length;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = resolve(values.out ?? join(config.cwd, '.bench-results', stamp));
    console.log(`bench: ${selected} variants, ${config.warmup} warm-up + ${config.runs} rounds, results in ${outDir}`);
    const results = await runBenchmark(config, { outDir, only });
    const markdown = formatMarkdown(results, summarize(results, { minimumEffect }));
    writeFileSync(join(outDir, 'summary.md'), markdown);
    console.log(`\n${markdown}`);
  } else if (command === 'profile') {
    const config = await loadConfig(values.config);
    const variant = values.variant ? config.variants.find((item) => item.name === values.variant) : config.variants[0];
    if (!variant) throw new Error(`No variant is named ${values.variant}`);
    prepare(config);
    const dir = mkdtempSync(join(tmpdir(), 'turbo-bench-'));
    const profileFile = join(dir, 'profile.json');
    const [bin, ...args] = config.command;
    const reporter = fileURLToPath(new URL('./src/profile-reporter.mjs', import.meta.url));
    const measured = await measure({
      command: bin,
      args: [...args, ...(variant.args ?? []), `--reporter=${reporter}`],
      cwd: config.cwd,
      env: { ...process.env, ...config.env, ...variant.env, BENCH_PROFILE: profileFile },
      logFile: join(dir, 'run.log'),
    });
    console.log(
      `${variant.name}: ${(measured.wallMs / 1000).toFixed(1)}s wall` +
        (measured.cpuMs !== undefined ? `, ${(measured.cpuMs / 1000).toFixed(1)}s CPU` : '') +
        (measured.peakMemoryMb !== undefined ? `, ${Math.round(measured.peakMemoryMb)} MiB peak` : '') +
        '\n',
    );
    if (existsSync(profileFile)) console.log(formatProfile(JSON.parse(readFileSync(profileFile, 'utf8'))));
    else console.log('The run wrote no profile: the suite did not run.');
    if (measured.exitCode !== 0)
      console.log(`\nThe run exited with ${measured.exitCode}; its output is in ${join(dir, 'run.log')}`);
  } else if (command === 'report') {
    if (!rest[0]) throw new Error('Name the results.json to report on');
    const results = JSON.parse(readFileSync(rest[0], 'utf8'));
    console.log(formatMarkdown(results, summarize(results, { minimumEffect })));
  } else {
    console.log(HELP);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`bench: ${error.message}`);
  process.exitCode = 1;
}
