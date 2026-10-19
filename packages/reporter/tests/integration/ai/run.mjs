/**
 * Orchestrates the AI-step integration E2E: it stands up a tiny app-under-test
 * page and a stub `/api/ai/step-resolution` server, then runs the spec twice —
 * once in `resolve` mode (authors the committed artifacts, hitting the stub) and
 * once in `replay` mode (executes those artifacts, and the stub asserts it is
 * never called). This proves the feature's core contract end to end against a
 * real browser with ZERO real LLM calls: the LLM is a compiler, not a runtime.
 *
 * Both servers run here in the parent; their URLs reach the Playwright workers
 * through the environment. Run via `npm run reporter:test:integration:ai`.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// Where the spec's committed artifacts land: <spec-dir>/<PIWI_AI_DIR>/<spec-file>/…
const AI_DIR = '.ai-e2e-artifacts';
const artifactRoot = path.join(here, AI_DIR);

// A value that must never leave the machine — the reporter masks it out of every
// outbound snapshot/history, so it must never appear in any request the stub sees.
const SECRET_EMAIL = 'ada@example.com';

// ── App under test: a labelled login form that fires an Ajax call on submit ──
const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <div id="app">
      <form id="f">
        <label for="email">Email</label>
        <input id="email" type="email" />
        <button type="submit">Sign in</button>
      </form>
    </div>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await fetch('/api/login', { method: 'POST' });
        await res.json();
        // Replace the whole form with the success state — like a real login
        // screen — so the Sign in button is gone once signed in.
        document.getElementById('app').innerHTML = '<h1>Welcome</h1>';
      });
    </script>
  </body>
</html>`;

function startAppServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/login') {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(PAGE_HTML) });
    res.end(PAGE_HTML);
  });
  return listen(server);
}

// ── Stub resolver: canned, deterministic decisions for our exact page ────────
//
// The reporter drives the loop; the stub just answers one iteration at a time,
// keyed off the request kind and how many steps have run so far. It records how
// many times it was called and whether the masked secret ever leaked into a
// request body, so the orchestrator can assert both.
function startStubResolver(state) {
  const email = { role: 'textbox', name: 'Email' };
  const signIn = { role: 'button', name: 'Sign in' };
  const welcome = { role: 'heading', name: 'Welcome', level: 1 };

  const decide = (req) => {
    if (req.kind === 'locator') {
      return { element: email };
    }
    if (req.kind === 'wait') {
      // Pick the glob replay should wait for from the URLs the click produced.
      return { waitForResponse: '**/api/login' };
    }
    // kind === 'run': advance the flow one step per iteration.
    const done = req.history.length;
    if (done === 0) return { element: email, action: 'fill', value: '{{email}}' };
    if (done === 1) return { element: signIn, action: 'click' };
    return { done: true, postcondition: { assert: 'visible', element: welcome } };
  };

  const server = http.createServer((req, res) => {
    if (!(req.method === 'POST' && req.url === '/api/ai/step-resolution')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      state.calls += 1;
      if (raw.includes(SECRET_EMAIL)) state.leaked = true;
      let decision;
      try {
        decision = decide(JSON.parse(raw));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: String(err) }));
        return;
      }
      const body = JSON.stringify(decision);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  return listen(server);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function runPlaywright(env) {
  // The `playwright` bin of the peer dependency, `@playwright/test/cli`. Spawn
  // async (not spawnSync): the app + stub servers live on THIS process's event
  // loop, and a synchronous child would block it — the browser could never reach
  // them.
  const cli = require.resolve('@playwright/test/cli');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', path.join(here, 'playwright.config.ts')], {
      cwd: here,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
  });
}

function fail(msg) {
  console.error(`\n[ai-e2e] FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  fs.rmSync(artifactRoot, { recursive: true, force: true });

  const app = await startAppServer();
  const stubState = { calls: 0, leaked: false };
  const stub = await startStubResolver(stubState);

  const shared = {
    PIWI_AI_DIR: AI_DIR,
    PIWI_E2E_APP_URL: app.url,
    // Bound every network wait so a stub/page mishap can never hang the suite.
    PIWI_AI_RESPONSE_WAIT_TIMEOUT: '8000',
  };

  try {
    // ── Phase 1: resolve — authors the committed artifacts via the stub ──────
    console.log('\n[ai-e2e] phase 1: resolve (authoring, stub answers each step)');
    const resolveStatus = await runPlaywright({
      ...shared,
      PIWI_AI: 'resolve',
      PIWI_DASHBOARD_URL: stub.url,
      PIWI_API_KEY: 'integration-test-key',
    });
    if (resolveStatus !== 0) fail(`resolve run exited ${resolveStatus}`);
    if (stubState.calls === 0) fail('the stub resolver was never called during resolve — nothing was authored');
    if (stubState.leaked) fail('the masked secret leaked into a resolution request body');

    const authoredCalls = stubState.calls;
    const files = fs.existsSync(artifactRoot)
      ? fs.readdirSync(path.join(artifactRoot, 'ai-steps.spec.ts')).filter((f) => f.endsWith('.json'))
      : [];
    if (files.length !== 2) fail(`expected 2 committed artifacts (locator + run), found ${files.length}`);

    // ── Phase 2: replay — executes the artifacts, stub must stay untouched ───
    console.log('\n[ai-e2e] phase 2: replay (committed artifacts, zero LLM)');
    stubState.calls = 0;
    const replayStatus = await runPlaywright({
      ...shared,
      PIWI_AI: 'replay',
      // Point at the stub anyway: if replay wrongly reaches for the model, the
      // call count below catches it.
      PIWI_DASHBOARD_URL: stub.url,
    });
    if (replayStatus !== 0) fail(`replay run exited ${replayStatus}`);
    if (stubState.calls !== 0) fail(`replay made ${stubState.calls} resolver call(s) — replay must never hit the LLM`);

    if (process.exitCode !== 1) {
      console.log(
        `\n[ai-e2e] PASS: authored ${files.length} artifacts in ${authoredCalls} stub calls, ` +
          `replayed them with 0 LLM calls and no secret leak.`,
      );
    }
  } finally {
    await new Promise((r) => app.server.close(() => r()));
    await new Promise((r) => stub.server.close(() => r()));
    // `PIWI_E2E_KEEP=1` leaves the authored artifacts on disk for inspection.
    if (process.env.PIWI_E2E_KEEP !== '1') fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
