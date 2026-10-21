#!/usr/bin/env node
/**
 * Render the performance suite's results as the Markdown of the pull-request
 * comment (or, for one target, a plain table).
 *
 * Usage (from apps/application/):
 *   node scripts/perf/report.mjs --results .perf/results.json [--out report.md] [--run-url <url>]
 *     [--base <target>] [--head <target>]
 *   node scripts/perf/report.mjs --results shard-1.json --results shard-2.json --merged results.json …
 *
 * The base and head default to the first and last targets of the run. The
 * results of every shard of a split run (`run.mjs --shard`) are joined into
 * one report; `--merged` keeps the joined results.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compareResults } from './lib/compare.mjs';
import { renderComparison, renderSingle } from './lib/markdown.mjs';
import { mergeResults } from './lib/merge.mjs';

const { values: opts } = parseArgs({
  options: {
    results: { type: 'string', multiple: true, default: ['.perf/results.json'] },
    merged: { type: 'string' },
    out: { type: 'string' },
    'run-url': { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string' },
  },
});

const results = mergeResults(opts.results.map((path) => JSON.parse(readFileSync(path, 'utf8'))));
if (opts.merged) writeFileSync(opts.merged, JSON.stringify(results, null, 2));
const names = results.meta.targets.map((t) => t.name);
const base = opts.base ?? names[0];
const head = opts.head ?? names.at(-1);
const markdown =
  base === head
    ? renderSingle(results.meta, results, head)
    : renderComparison(results.meta, compareResults(results, base, head), { links: { run: opts['run-url'] } });

if (opts.out) writeFileSync(opts.out, markdown);
else process.stdout.write(`${markdown}\n`);
