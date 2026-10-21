#!/usr/bin/env node
/**
 * Performance regression suite for the dashboard's heaviest pages: the
 * projects list, every tab of a project, the test-run page, and a failed
 * execution's page with a large trace.
 *
 * Each target is a production build (`.output`). The first one migrates a
 * fresh database and the dataset is written into it (`lib/dataset.mjs`), then
 * every target runs as its own server on a copy, signed in as an
 * administrator, so a newer build migrates the copy the way an upgrade would.
 * For each page it measures the server render over HTTP and the full load in
 * Chromium, then replays every API call the pages made. On PostgreSQL every
 * request's SQL is read from `pg_stat_statements`; a last pass with
 * OpenTelemetry on lists the SQL each request ran, on builds that trace.
 *
 * `--shard 2/3` measures the second third of the pages, and only the API calls
 * they make (the first shard adds the ones no page makes in the browser), so
 * machines can share the suite; `report.mjs` joins their results.
 *
 * Usage (from apps/application/, after `npm run app:build`):
 *   node scripts/perf/run.mjs                                  # this build alone, SQLite
 *   node scripts/perf/run.mjs --target base=../main/apps/application/.output --target head=.output
 *   node scripts/perf/run.mjs --database postgres --pg-url postgresql://postgres:postgres@localhost:5432/postgres
 *   node scripts/perf/run.mjs --scale small --pages projects,project-runs --no-browser
 *
 * Options: --scale small|medium|large (default large) · --warmup N · --ssr-samples N ·
 * --load-samples N · --api-samples N · --pages id,id · --shard k/n · --no-browser · --no-trace ·
 * --label name=text · --out results.json · --report report.md · --work-dir dir · --reuse-seed
 *
 * PostgreSQL needs pg_stat_statements loaded at startup (see lib/pg.mjs).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { datasetBatches, DATASET_VERSION, MAIN_PROJECT } from './lib/dataset.mjs';
import { openPostgresWriter, openSqliteWriter, writeDataset } from './lib/seed-writer.mjs';
import { createAdmin, signIn, startServer, waitForIdle } from './lib/targets.mjs';
import { importPerfTrace } from './lib/trace.mjs';
import {
  activeStatements,
  connectAdmin,
  databaseUrl,
  dropDatabase,
  nameStatements,
  recreateDatabase,
  redact,
  statementDelta,
  statementSnapshot,
} from './lib/pg.mjs';
import { startOtlpReceiver } from './lib/otlp-receiver.mjs';
import { fetchTimed, loadPage, signedInContext } from './lib/measure.mjs';
import { knownApiPaths, pageScenarios, shardPages } from './lib/scenarios.mjs';
import { mode } from './lib/stats.mjs';
import { compareResults } from './lib/compare.mjs';
import { renderComparison, renderSingle } from './lib/markdown.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const { values: opts } = parseArgs({
  options: {
    target: { type: 'string', multiple: true },
    label: { type: 'string', multiple: true },
    database: { type: 'string', default: 'sqlite' },
    'pg-url': { type: 'string', default: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' },
    scale: { type: 'string', default: 'large' },
    warmup: { type: 'string', default: '2' },
    'ssr-samples': { type: 'string', default: '12' },
    'load-samples': { type: 'string', default: '6' },
    'api-samples': { type: 'string', default: '8' },
    pages: { type: 'string' },
    shard: { type: 'string' },
    'no-browser': { type: 'boolean', default: false },
    'no-trace': { type: 'boolean', default: false },
    out: { type: 'string', default: '.perf/results.json' },
    report: { type: 'string' },
    'work-dir': { type: 'string', default: '.perf' },
    'reuse-seed': { type: 'boolean', default: false },
  },
});

const intOpt = (name) => {
  const n = Number(opts[name]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a whole number`);
  return n;
};
const samples = {
  warmup: intOpt('warmup'),
  ssr: intOpt('ssr-samples'),
  load: intOpt('load-samples'),
  api: intOpt('api-samples'),
};
const dialect = opts.database;
if (!['sqlite', 'postgres'].includes(dialect)) throw new Error('--database is sqlite or postgres');
const shard = opts.shard ? parseShard(opts.shard) : null;

function parseShard(spec) {
  const [index, total] = spec.split('/').map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total)
    throw new Error(`--shard needs k/n with 1 ≤ k ≤ n, got "${spec}"`);
  return { index, total };
}

const targets = (opts.target?.length ? opts.target : ['head=.output']).map((spec) => {
  const eq = spec.indexOf('=');
  if (eq < 1) throw new Error(`--target needs name=path/to/.output, got "${spec}"`);
  const name = spec.slice(0, eq);
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`target name "${name}" must be letters, digits, - or _`);
  return { name, outputDir: resolve(spec.slice(eq + 1)) };
});
const labels = Object.fromEntries(
  (opts.label ?? []).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const workDir = resolve(APP_DIR, opts['work-dir']);
mkdirSync(workDir, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/** Alternate the order targets are measured in, so neither always goes first. */
const inTurn = (round) => (round % 2 === 0 ? targets : [...targets].reverse());

// ─── Dataset ─────────────────────────────────────────────────────────────────

let pg = null;
const pgDatabase = (name) => `piwi_perf_${name.replace(/-/g, '_')}`;
/** Where the seed's server runs and keeps its storage, one per dialect like the seed itself. */
const seedServerDir = () => join(workDir, `seed-server-${dialect}`);

/**
 * Migrate a fresh database with the first target's build, create the
 * administrator, write the dataset, let that build's startup work (rollup
 * backfill, re-clustering) run once on it, and upload the suite's trace — the
 * state every copy starts from, database and storage alike.
 */
async function prepareSeed() {
  const reference = targets[0];
  const seedKey = JSON.stringify({
    v: DATASET_VERSION,
    scale: opts.scale,
    dialect,
    build: buildStamp(reference.outputDir),
  });
  const keyPath = join(workDir, `seed-${dialect}.json`);
  const seedDb =
    dialect === 'sqlite'
      ? { path: join(workDir, 'seed', 'piwi.db') }
      : { url: databaseUrl(opts['pg-url'], pgDatabase('seed')) };

  if (opts['reuse-seed'] && existsSync(keyPath)) {
    const saved = JSON.parse(readFileSync(keyPath, 'utf8'));
    if (saved.key === seedKey) {
      log(`Reusing the ${opts.scale} seed from ${saved.createdAt}`);
      return saved.manifest;
    }
  }

  log(`Seeding the ${opts.scale} dataset with ${reference.name}…`);
  const started = Date.now();
  if (dialect === 'sqlite') {
    rmSync(dirname(seedDb.path), { recursive: true, force: true });
    mkdirSync(dirname(seedDb.path), { recursive: true });
  } else {
    await recreateDatabase(pg.sql, pgDatabase('seed'));
  }
  const port = await freePort();
  const seedWork = seedServerDir();
  rmSync(join(seedWork, 'storage'), { recursive: true, force: true });
  let server = await startServer({
    name: `${reference.name} (seed)`,
    outputDir: reference.outputDir,
    port,
    database: seedDb,
    workDir: seedWork,
    log,
  });
  try {
    await createAdmin(server);
  } finally {
    await server.stop();
  }

  const writer = dialect === 'sqlite' ? await openSqliteWriter(seedDb.path) : await openPostgresWriter(seedDb.url);
  const manifest = await writeDataset(writer, datasetBatches({ scale: opts.scale, now: new Date() }));
  log(
    `  wrote ${Object.entries(manifest.counts)
      .map(([t, n]) => `${n.toLocaleString('en-US')} ${t}`)
      .join(', ')} in ${Math.round((Date.now() - started) / 1000)} s`,
  );

  server = await startServer({
    name: `${reference.name} (seed)`,
    outputDir: reference.outputDir,
    port,
    database: seedDb,
    workDir: seedWork,
    log,
  });
  const idle = () =>
    waitForIdle(server, { activeStatements: pg ? () => activeStatements(pg.sql, pgDatabase('seed')) : null, log });
  try {
    await idle();
    const traceRunId = await importPerfTrace(server, MAIN_PROJECT.name, manifest.trace);
    manifest.executionId = await importedExecutionId(seedDb, traceRunId);
    log(`  trace uploaded to execution #${manifest.executionId}`);
    await idle();
  } finally {
    await server.stop();
  }
  if (dialect === 'sqlite') await checkpointSqlite(seedDb.path);
  writeFileSync(keyPath, JSON.stringify({ key: seedKey, manifest, createdAt: new Date().toISOString() }, null, 2));
  log(`  seed ready in ${Math.round((Date.now() - started) / 1000)} s`);
  return manifest;
}

/**
 * Fold the writes a stopped server left in SQLite's write-ahead log into the
 * database file, which is all `copySeed` copies.
 */
async function checkpointSqlite(path) {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: `file:${path}` });
  try {
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    client.close();
  }
}

/** The execution the trace import created in run `runId`. */
async function importedExecutionId(seedDb, runId) {
  const query = 'SELECT id FROM test_runs_cases WHERE test_run_id = $1 ORDER BY id LIMIT 1';
  let rows;
  if (seedDb.path) {
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: `file:${seedDb.path}` });
    try {
      ({ rows } = await client.execute({ sql: query.replace('$1', '?'), args: [runId] }));
    } finally {
      client.close();
    }
  } else {
    const { default: postgres } = await import('postgres');
    const sql = postgres(seedDb.url, { max: 1, onnotice: () => {} });
    try {
      rows = await sql.unsafe(query, [runId]);
    } finally {
      await sql.end();
    }
  }
  if (!rows[0]) throw new Error(`the trace import's run #${runId} holds no execution`);
  return Number(rows[0].id);
}

function buildStamp(outputDir) {
  try {
    return JSON.parse(readFileSync(join(outputDir, 'nitro.json'), 'utf8')).date;
  } catch {
    return null;
  }
}

/** Give each target its own copy of the seed: its database and its stored files. */
async function copySeed(target) {
  const storage = join(workDir, target.name, 'storage');
  rmSync(storage, { recursive: true, force: true });
  cpSync(join(seedServerDir(), 'storage'), storage, { recursive: true });
  if (dialect === 'sqlite') {
    const dir = join(workDir, target.name);
    rmSync(join(dir, 'db'), { recursive: true, force: true });
    mkdirSync(join(dir, 'db'), { recursive: true });
    copyFileSync(join(workDir, 'seed', 'piwi.db'), join(dir, 'db', 'piwi.db'));
    return { path: join(dir, 'db', 'piwi.db') };
  }
  await recreateDatabase(pg.sql, pgDatabase(target.name), pgDatabase('seed'));
  return { url: databaseUrl(opts['pg-url'], pgDatabase(target.name)) };
}

// ─── Measurement ─────────────────────────────────────────────────────────────

/** Run `fn` and, on PostgreSQL, read the statements it caused in `target`'s database. */
async function withStatements(target, fn) {
  if (!pg) return { result: await fn(), db: null };
  const database = pgDatabase(target.name);
  const before = await statementSnapshot(pg.sql, database);
  const result = await fn();
  // Statements a request starts as it answers land a moment after the response.
  await sleep(25);
  const after = await statementSnapshot(pg.sql, database);
  return { result, db: statementDelta(before, after) };
}

/** The SQL breakdown of the sample whose statement count is the usual one. */
function typicalSql(deltas) {
  const counts = deltas.map((d) => d?.statements).filter(Number.isFinite);
  if (!counts.length) return null;
  const usual = mode(counts);
  const d = deltas.find((x) => x?.statements === usual);
  return { source: 'pg_stat_statements', statements: d.statements, ms: d.ms, queries: d.queries, nested: [] };
}

async function startTargets({ otel }) {
  const servers = [];
  for (const target of targets) {
    const server = await startServer({
      name: target.name,
      outputDir: target.outputDir,
      port: await freePort(),
      database: target.database,
      workDir: join(workDir, target.name),
      otel: otel ? { endpoint: otel.endpoint, serviceName: `piwi-perf-${target.name}` } : null,
      log,
    });
    servers.push(server);
  }
  await Promise.all(
    servers.map((s) =>
      waitForIdle(s, { activeStatements: pg ? () => activeStatements(pg.sql, pgDatabase(s.name)) : null, log }),
    ),
  );
  for (const s of servers) await signIn(s);
  return Object.fromEntries(servers.map((s) => [s.name, s]));
}

async function main() {
  const startedAt = new Date();
  if (dialect === 'postgres') {
    pg = await connectAdmin(opts['pg-url']);
    log(`PostgreSQL ${pg.version} at ${redact(opts['pg-url'])}`);
  }
  const manifest = await prepareSeed();
  for (const target of targets) target.database = await copySeed(target);

  const chosen = pageScenarios(manifest).filter((p) => !opts.pages || opts.pages.split(',').includes(p.id));
  if (chosen.length === 0)
    throw new Error(
      `--pages matched no page (known: ${pageScenarios(manifest)
        .map((p) => p.id)
        .join(', ')})`,
    );
  const pages = shard ? shardPages(chosen, shard) : chosen;
  if (pages.length === 0) throw new Error(`shard ${opts.shard} holds none of the ${chosen.length} pages`);

  const results = {
    version: 1,
    meta: {
      startedAt: startedAt.toISOString(),
      database: dialect,
      databaseVersion: pg?.version ?? null,
      scale: opts.scale,
      dataset: manifest.counts,
      samples,
      shard,
      targets: targets.map((t) => ({ name: t.name, outputDir: t.outputDir, built: buildStamp(t.outputDir) })),
      targetLabels: Object.fromEntries(
        targets.map((t, i) => [
          i === 0 ? 'base' : i === targets.length - 1 ? 'head' : t.name,
          labels[t.name] ?? t.name,
        ]),
      ),
      machine: {
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model?.trim(),
        node: process.version,
        platform: process.platform,
      },
    },
    pages: pages.map((p) => ({
      ...p,
      targets: Object.fromEntries(targets.map((t) => [t.name, { ssr: newSsr(), load: newLoad() }])),
    })),
    apis: [],
  };

  let browser = null;
  if (!opts['no-browser']) {
    const { chromium } = require('playwright');
    const provided = process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium');
    browser = await chromium.launch(provided && existsSync(provided) ? { executablePath: provided } : {});
  }

  // Pass 1: timings and, on PostgreSQL, statement counts — tracing off, so it costs nothing.
  log('Starting the targets…');
  let servers = await startTargets({ otel: null });
  const contexts = {};
  if (browser) for (const t of targets) contexts[t.name] = await signedInContext(browser, servers[t.name]);
  // The calls no page makes in the browser are measured once, by the first shard.
  const known = !shard || shard.index === 1 ? knownApiPaths(manifest) : [];
  const discovered = new Map(known.map((p) => [p, new Set()]));

  try {
    log(`Warming up (${samples.warmup} rounds)…`);
    for (let round = 0; round < samples.warmup; round++) {
      for (const page of pages) {
        for (const t of inTurn(round)) {
          await fetchTimed(servers[t.name], page.path, 'text/html');
          if (browser && round === 0) await loadPage(contexts[t.name], servers[t.name], page.path).catch(() => {});
        }
      }
    }

    log(`Server renders (${samples.ssr} per page)…`);
    for (let round = 0; round < samples.ssr; round++) {
      for (const page of results.pages) {
        for (const t of inTurn(round)) {
          const { result, db } = await withStatements(t, () => fetchTimed(servers[t.name], page.path, 'text/html'));
          const s = page.targets[t.name].ssr;
          s.ms.push(result.ms);
          s.ttfb.push(result.ttfb);
          s.bytes.push(result.bytes);
          s.status = result.status;
          if (db) {
            s.statements.push(db.statements);
            s.blocks.push(db.blocks);
            s.dbMs.push(db.ms);
            s.deltas.push(db);
          }
        }
      }
      process.stdout.write('.');
    }
    process.stdout.write('\n');

    if (browser && samples.load > 0) {
      log(`Browser loads (${samples.load} per page)…`);
      for (let round = 0; round < samples.load; round++) {
        for (const page of results.pages) {
          for (const t of inTurn(round)) {
            const { result, db } = await withStatements(t, () =>
              loadPage(contexts[t.name], servers[t.name], page.path),
            );
            const l = page.targets[t.name].load;
            l.ms.push(result.ms);
            l.apiRequests.push(result.apiRequests);
            l.blockingMs.push(result.blockingMs);
            l.domNodes.push(result.domNodes);
            l.lcpMs.push(result.lcpMs);
            l.requests = result.requests.map(({ method, url, status, ms }) => ({ method, url, status, ms }));
            if (db) {
              l.statements.push(db.statements);
              l.deltas.push(db);
            }
            for (const r of result.requests) {
              if (!r.api) continue;
              if (!discovered.has(r.url)) discovered.set(r.url, new Set());
              discovered.get(r.url).add(page.id);
            }
          }
        }
        process.stdout.write('.');
      }
      process.stdout.write('\n');
    }

    results.apis = [...discovered.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, calledBy]) => ({
        path,
        calledBy: [...calledBy],
        targets: Object.fromEntries(
          targets.map((t) => [t.name, { ms: [], bytes: [], statements: [], blocks: [], deltas: [], status: null }]),
        ),
      }));
    if (samples.api > 0) {
      log(`API calls (${results.apis.length} requests × ${samples.api})…`);
      for (let round = 0; round < samples.api; round++) {
        for (const api of results.apis) {
          for (const t of inTurn(round)) {
            const { result, db } = await withStatements(t, () =>
              fetchTimed(servers[t.name], api.path, 'application/json'),
            );
            const a = api.targets[t.name];
            a.ms.push(result.ms);
            a.bytes.push(result.bytes);
            a.status = result.status;
            if (db) {
              a.statements.push(db.statements);
              a.blocks.push(db.blocks);
              a.deltas.push(db);
            }
          }
        }
        process.stdout.write('.');
      }
      process.stdout.write('\n');
    }
  } finally {
    for (const c of Object.values(contexts)) await c.close();
    await Promise.all(Object.values(servers).map((s) => s.stop()));
  }

  // Each request's SQL from pass 1, on PostgreSQL.
  for (const page of results.pages) {
    for (const t of targets) {
      const r = page.targets[t.name];
      r.ssr.sql = typicalSql(r.ssr.deltas);
      r.load.sql = typicalSql(r.load.deltas);
      delete r.ssr.deltas;
      delete r.load.deltas;
    }
  }
  for (const api of results.apis) {
    for (const t of targets) {
      const r = api.targets[t.name];
      r.sql = typicalSql(r.deltas);
      r.calledBy = api.calledBy;
      delete r.deltas;
    }
  }
  if (pg) {
    for (const t of targets) {
      const breakdowns = [
        ...results.pages.flatMap((page) => [page.targets[t.name].ssr.sql, page.targets[t.name].load.sql]),
        ...results.apis.map((api) => api.targets[t.name].sql),
      ];
      await nameStatements(
        pg.sql,
        pgDatabase(t.name),
        breakdowns.flatMap((b) => b?.queries ?? []),
      );
    }
  }

  // Pass 2: the SQL of every request, from OpenTelemetry, on the builds that trace. Nothing is timed, so the
  // builds run side by side.
  if (!opts['no-trace']) {
    log('Tracing pass (OpenTelemetry)…');
    const receiver = await startOtlpReceiver();
    servers = await startTargets({ otel: receiver });
    const traceContexts = {};
    if (browser) for (const t of targets) traceContexts[t.name] = await signedInContext(browser, servers[t.name]);
    const traced = Object.fromEntries(targets.map((t) => [t.name, { pages: {}, apis: {} }]));
    try {
      await Promise.all(
        targets.map(async (t) => {
          const server = servers[t.name];
          // A build that predates tracing names no trace; nothing to collect from it.
          await fetchTimed(server, '/api/auth/me', 'application/json');
          if (!(await fetchTimed(server, '/api/auth/me', 'application/json')).traceId) return;
          for (const page of results.pages) {
            await fetchTimed(server, page.path, 'text/html');
            const render = await fetchTimed(server, page.path, 'text/html');
            const load = browser ? await loadPage(traceContexts[t.name], server, page.path).catch(() => null) : null;
            traced[t.name].pages[page.id] = { render: render.traceId, load };
          }
          for (const api of results.apis)
            traced[t.name].apis[api.path] = (await fetchTimed(server, api.path, 'application/json')).traceId;
        }),
      );
    } finally {
      for (const c of Object.values(traceContexts)) await c.close();
      // Stopping flushes the spans still queued.
      await Promise.all(Object.values(servers).map((s) => s.stop()));
      await sleep(500);
      await receiver.close();
    }
    const tracing = targets.filter((t) => Object.values(traced[t.name].apis).some(Boolean));
    log(
      `  ${receiver.received().toLocaleString('en-US')} spans received; tracing builds: ${tracing.map((t) => t.name).join(', ') || 'none'}`,
    );
    const everyTargetTraces = tracing.length === targets.length;

    const loadSql = (load) => {
      if (!load) return null;
      const perRequest = [];
      const queries = new Map();
      let statements = 0;
      for (const r of [{ url: '(document)', traceId: load.documentTraceId }, ...load.requests]) {
        const sql = r.traceId ? receiver.requestSql(r.traceId) : null;
        if (!sql) continue;
        statements += sql.statements;
        perRequest.push({ request: `${r.method ?? 'GET'} ${r.url}`, statements: sql.statements });
        for (const q of sql.queries) {
          const e = queries.get(q.query) ?? { query: q.query, calls: 0, ms: 0 };
          e.calls += q.calls;
          e.ms += q.ms;
          queries.set(q.query, e);
        }
      }
      return {
        source: 'opentelemetry',
        statements,
        queries: [...queries.values()].sort((a, b) => b.calls - a.calls),
        nested: perRequest.sort((a, b) => b.statements - a.statements),
      };
    };

    for (const t of tracing) {
      for (const page of results.pages) {
        const r = page.targets[t.name];
        const { render, load } = traced[t.name].pages[page.id];
        const renderSql = render ? receiver.requestSql(render) : null;
        if (renderSql) renderSql.source = 'opentelemetry';
        const loadTrace = loadSql(load);
        // PostgreSQL's counts compare every build; OpenTelemetry's replace them when every build traces.
        if (everyTargetTraces || !pg) {
          r.ssr.sql = renderSql;
          r.load.sql = loadTrace;
          if (!pg) {
            r.ssr.statements = renderSql ? [renderSql.statements] : [];
            r.load.statements = loadTrace ? [loadTrace.statements] : [];
          }
        } else if (r.ssr.sql && renderSql) {
          r.ssr.sql.nested = renderSql.nested;
        }
        if (!(everyTargetTraces || !pg) && r.load.sql && loadTrace) r.load.sql.nested = loadTrace.nested;
      }
      for (const api of results.apis) {
        const traceId = traced[t.name].apis[api.path];
        const sql = traceId ? receiver.requestSql(traceId) : null;
        if (!sql) continue;
        sql.source = 'opentelemetry';
        if (everyTargetTraces || !pg) {
          api.targets[t.name].sql = sql;
          if (!pg) api.targets[t.name].statements = [sql.statements];
        }
      }
    }
  }

  if (browser) await browser.close();
  if (pg) {
    for (const t of targets) await dropDatabase(pg.sql, pgDatabase(t.name));
    await pg.sql.end();
  }

  results.meta.finishedAt = new Date().toISOString();
  const outPath = resolve(APP_DIR, opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  log(`Results: ${outPath}`);

  const markdown =
    targets.length >= 2
      ? renderComparison(results.meta, compareResults(results, targets[0].name, targets.at(-1).name))
      : renderSingle(results.meta, results, targets[0].name);
  if (opts.report) {
    const reportPath = resolve(APP_DIR, opts.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, markdown);
    log(`Report: ${reportPath}`);
  }
  log('');
  log(markdown);
}

function newSsr() {
  return { ms: [], ttfb: [], bytes: [], statements: [], blocks: [], dbMs: [], deltas: [], status: null, sql: null };
}

function newLoad() {
  return {
    ms: [],
    apiRequests: [],
    blockingMs: [],
    domNodes: [],
    lcpMs: [],
    statements: [],
    deltas: [],
    requests: [],
    sql: null,
  };
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  if (pg) await pg.sql.end({ timeout: 1 }).catch(() => {});
});
