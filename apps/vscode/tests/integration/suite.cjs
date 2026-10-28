// Runs inside VS Code's extension host (see run.mjs): each test drives the
// editor through its public commands, as a user's actions would.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const workspace = process.env.PIWI_TEST_WORKSPACE;
const pageObject = vscode.Uri.file(path.join(workspace, 'tests', 'pages', 'checkout.page.ts'));

// Retries through cancellations too: a request made while a document opens can be canceled.
async function waitFor(read, what, ms = 30_000) {
  const start = Date.now();
  for (;;) {
    const value = await Promise.resolve()
      .then(read)
      .catch(() => null);
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** One JSON message a line from `socket` into `heard`, as the run and record channels frame them. */
function readLines(socket, heard, onMessage = () => {}) {
  socket.setEncoding('utf8');
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      heard.push(message);
      onMessage(message);
    }
  });
  return (message) => socket.write(`${JSON.stringify(message)}\n`);
}

/**
 * Worker 0 of the run `ref` on the run channel `channel` names, as the capture fixtures play it, its reporter taking
 * `takes`: what it heard, what it sends, and the requests it answers at once (`answers`, by what they ask).
 */
function runWorker(channel, ref, takes) {
  const net = require('node:net');
  const hash = channel.lastIndexOf('#');
  const socket = net.connect(channel.slice(0, hash));
  const heard = [];
  const answers = {};
  const send = readLines(socket, heard, (m) => {
    if (m.type === 'request' && m.what in answers) {
      send({ type: 'answer', request: m.request, what: m.what, value: answers[m.what] });
    }
  });
  send({
    type: 'run-attach',
    token: channel.slice(hash + 1),
    ref,
    cwd: workspace,
    workerIndex: 0,
    parallelIndex: 0,
    pid: process.pid,
    playwright: '1.64.1',
    reporter: '0.60.0',
    ...(takes ? { takes } : {}),
  });
  return {
    socket,
    heard,
    send,
    answers,
    heardOne: (what, test, from = 0) => waitFor(() => heard.slice(from).find(test), what),
  };
}

/** The test's half of a hand-off on the record channel `channel` names, opened with `attach`: what it heard and sends. */
function handoff(channel, attach) {
  const net = require('node:net');
  const hash = channel.lastIndexOf('#');
  const socket = net.connect(channel.slice(0, hash));
  const heard = [];
  const send = readLines(socket, heard);
  send({ type: 'attach', token: channel.slice(hash + 1), ...attach });
  return { socket, heard, send };
}

/** The titles of the lenses on the line whose first lens starts with `prefix` in `uri`'s file; none without one. */
async function stopLenses(uri, prefix) {
  const lenses = (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri)) ?? [];
  const first = lenses.find((l) => l.command?.title.startsWith(prefix));
  return first ? lenses.filter((l) => l.range.start.line === first.range.start.line).map((l) => l.command.title) : [];
}

const tests = {
  async 'the extension activates on a workspace with a Playwright config'() {
    const extension = vscode.extensions.getExtension('piwitests.piwi');
    assert.ok(extension, 'the extension is installed');
    await extension.activate();
    assert.equal(extension.isActive, true);
  },

  async 'the latest run’s failure is in the Problems panel at its failing line'() {
    const failure = await waitFor(
      () => vscode.languages.getDiagnostics(pageObject).find((d) => d.code?.value === 'ci-failure'),
      'the CI failure diagnostic',
    );
    assert.equal(failure.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(failure.range.start.line, 4);
    assert.equal(failure.message, "locator('.cart-row').nth(2) was not found (removes a row, run #41)");
  },

  async 'its quick fixes heal in place and open the evidence'() {
    await vscode.window.showTextDocument(pageObject);
    const failure = vscode.languages.getDiagnostics(pageObject).find((d) => d.code?.value === 'ci-failure');
    const actions = await waitFor(async () => {
      const found = await vscode.commands.executeCommand(
        'vscode.executeCodeActionProvider',
        pageObject,
        failure.range,
        vscode.CodeActionKind.QuickFix.value,
      );
      return found?.some((a) => a.title.startsWith('Heal')) ? found : null;
    }, 'the heal quick fix');
    const titles = actions.map((a) => a.title);
    assert.ok(titles.includes("Heal: use getByRole('row', { name: /Mug/ })"), titles.join(' | '));
    assert.ok(titles.includes('Open the trace'), titles.join(' | '));
    assert.ok(titles.includes('Open the failure in the dashboard'), titles.join(' | '));
    assert.ok(titles.includes('Copy context for agent'), titles.join(' | '));
    const copy = actions.find((a) => a.title === 'Copy context for agent');
    await vscode.commands.executeCommand(copy.command.command, ...copy.command.arguments);
    assert.match(await vscode.env.clipboard.readText(), /^# Failing test: removes a row/);

    const heal = actions.find((a) => a.title.startsWith('Heal'));
    assert.ok(await vscode.workspace.applyEdit(heal.edit));
    const document = await vscode.workspace.openTextDocument(pageObject);
    assert.equal(document.lineAt(4).text, "  row = () => this.page.getByRole('row', { name: /Mug/ });");
    await vscode.commands.executeCommand('undo');
  },

  async 'CodeLens shows the tests behind each locator line'() {
    const lenses = await waitFor(async () => {
      const found = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', pageObject);
      return found?.length ? found : null;
    }, 'the CodeLens');
    const titles = lenses.map((l) => l.command?.title);
    assert.ok(titles.includes('1 test · click'), titles.join(' | '));
    assert.ok(titles.includes('1 test · click · 1 failing'), titles.join(' | '));
  },

  async 'the gutter shows each test’s result with CodeLens turned off'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const editorSettings = vscode.workspace.getConfiguration('editor');
    await editorSettings.update('codeLens', false, vscode.ConfigurationTarget.Workspace);
    try {
      const spec = vscode.Uri.file(path.join(workspace, 'tests', 'checkout.spec.ts'));
      await vscode.window.showTextDocument(spec);
      const drawn = await waitFor(() => {
        const tests = api.gutter(spec.toString());
        return tests.length ? tests : null;
      }, 'the gutter of checkout.spec.ts');
      assert.deepEqual(
        drawn.map((t) => [t.line, t.status]),
        [[2, 'passed']],
      );
    } finally {
      await editorSettings.update('codeLens', undefined, vscode.ConfigurationTarget.Workspace);
    }
  },

  async 'the Testing view lists the tests Piwi knows, with their latest result'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'checkout.spec.ts')).toString();
    const shown = await waitFor(() => {
      const tests = (api.testExplorer() ?? []).filter((t) => t.uri === spec);
      return tests.some((t) => t.result) ? tests : null;
    }, 'the Testing view’s tests of checkout.spec.ts');
    assert.deepEqual(
      shown.map((t) => [t.label, t.line, t.result?.state]),
      [['pays', 2, 'passed']],
    );
  },

  async 'the Testing view runs a test with the command Piwi builds, as the editor’s own run'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    await vscode.commands.executeCommand('testing.runAll');
    const run = await waitFor(() => api.lastRun(), 'the run the Testing view started');
    assert.equal(run.command, 'npx playwright test tests/checkout.spec.ts:3');
    assert.match(run.ref, /^ed-[0-9a-f]{8}$/);
    assert.equal(run.env.PIWI_ORIGIN_REF, run.ref);
  },

  async 'hover shows the failure'() {
    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      pageObject,
      new vscode.Position(4, 30),
    );
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : c.value))
      .join('\n');
    assert.match(text, /\*\*CI failure\*\* · \[removes a row\]/);
  },

  async 'page. completes with the chains the suite uses on this file’s pages'() {
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'checkout.spec.ts'));
    const editor = await vscode.window.showTextDocument(spec);
    const end = editor.document.lineAt(2).range.end;
    await editor.edit((e) => e.insert(end, '\n  page.'));
    const list = await waitFor(async () => {
      const found = await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        spec,
        new vscode.Position(3, '  page.'.length),
        '.',
      );
      return found?.items.some((i) => (typeof i.label === 'string' ? i.label : i.label.label).startsWith('locator('))
        ? found
        : null;
    }, 'the locator completion');
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes("locator('.cart-row').nth(2)"), labels.slice(0, 5).join(' | '));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  },

  async 'Piwi Picker sends a locator and a recorded flow to the cursor'() {
    await vscode.commands.executeCommand('piwi.pairPicker');
    const pairing = await vscode.env.clipboard.readText();
    const [url, token] = pairing.split('#');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/piwi\/send$/);
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'checkout.spec.ts'));
    const editor = await vscode.window.showTextDocument(spec);
    const end = editor.document.lineAt(2).range.end;
    editor.selection = new vscode.Selection(end, end);
    await editor.edit((e) => e.insert(end, '\n  '));
    const send = (body) =>
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const locator = await send({ kind: 'locator', text: "page.getByRole('button', { name: 'Pay now' })" });
    assert.equal(locator.status, 200);
    assert.equal((await locator.json()).file, spec.fsPath);
    assert.ok(editor.document.getText().includes("  page.getByRole('button', { name: 'Pay now' })"));

    await editor.edit((e) => e.insert(editor.selection.active, '\n  '));
    const steps = await send({
      kind: 'steps',
      steps: {
        v: 1,
        title: null,
        origin: 'https://shop.test',
        recordedAt: 1000,
        note: null,
        steps: [
          { action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 1 },
          {
            action: 'click',
            target: {
              tagName: 'button',
              role: 'button',
              accessibleName: 'Pay now',
              testId: null,
              text: 'Pay now',
              alternatives: [{ locator: "getByRole('button', { name: 'Pay now' })", method: 'getByRole', score: 90 }],
            },
            value: null,
            redacted: false,
            pageUrl: '/cart',
            timestamp: 2,
          },
        ],
      },
    });
    assert.equal(steps.status, 200, await steps.clone().text());
    assert.ok(editor.document.getText().includes("  await page.getByRole('button', { name: 'Pay now' }).click();"));

    const refused = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' });
    assert.equal(refused.status, 401);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  },

  async 'Piwi Picker finds the hub of the window’s editor service through the pairing'() {
    const [url, token] = (await vscode.env.clipboard.readText()).split('#');
    const live = url.replace(/\/send$/, '/live');
    // Before it sends the token, Piwi Picker has the listener prove it holds it, for the port it answers on.
    const challenge = require('node:crypto').randomBytes(32).toString('hex');
    const unpaired = await fetch(live, { headers: { 'x-piwi-editor-challenge': challenge } });
    assert.equal(unpaired.status, 401);
    const proof = require('node:crypto')
      .createHmac('sha256', token)
      .update(`piwi-editor-proof:${new URL(url).port}:${challenge}`)
      .digest('hex');
    assert.equal(unpaired.headers.get('x-piwi-editor-proof'), proof);
    const hubs = await waitFor(async () => {
      const res = await fetch(live, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      return body.hubs.find((h) => h.roots.includes(workspace)) && body.hubs;
    }, 'the window’s hub');
    const hub = hubs.find((h) => h.roots.includes(workspace));
    assert.match(hub.url, /^ws:\/\/127\.0\.0\.1:\d+\/piwi\/hub$/);
    // Its own discovery file, in the folder the run names, readable by this user alone.
    const file = path.join(process.env.PIWI_EDITORS_DIR, `${hub.pid}.json`);
    if (process.platform !== 'win32') assert.equal(require('node:fs').statSync(file).mode & 0o777, 0o600);
    // The hub takes an extension's handshake at that address, and refuses a page's.
    const handshake = (origin) =>
      new Promise((resolve, reject) => {
        const request = require('node:http').request(hub.url.replace(/^ws:/, 'http:'), {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': require('node:crypto').randomBytes(16).toString('base64'),
            Origin: origin,
          },
        });
        request.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode);
        });
        request.on('response', (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        request.on('error', reject);
        request.end();
      });
    assert.equal(await handshake(`chrome-extension://${'a'.repeat(32)}`), 101);
    assert.equal(await handshake(new URL(url).origin), 403);
  },

  async 'the page recorded steps run on is offered from the code around the cursor'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'admin.spec.ts'));
    await vscode.workspace.openTextDocument(spec);
    const inTest = await waitFor(
      () => api.pageCandidates({ uri: spec.toString(), line: 4, character: 2 }),
      'the page candidates in a test',
    );
    const expressions = inTest.candidates.map((c) => c.expression);
    assert.equal(inTest.context, 'test');
    assert.equal(inTest.default, 'adminPage');
    assert.ok(expressions.includes('adminPage') && expressions.includes('page'), expressions.join(' | '));
    const inClass = await api.pageCandidates({ uri: pageObject.toString(), line: 4, character: 2 });
    assert.equal(inClass.context, 'class');
    assert.equal(inClass.default, 'this.page');
  },

  async 'the failures view lists the latest run’s failure under the run and its spec'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const roots = await waitFor(async () => {
      const found = await api.failureChildren();
      return found.length ? found : null;
    }, 'the failures view');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].label, 'Run #41 · CI · main · 1 failing');
    const groups = await api.failureChildren(roots[0]);
    assert.deepEqual(
      groups.map((g) => [g.label, g.description]),
      [['tests/checkout.spec.ts', '1 failing']],
    );
    const [leaf] = await api.failureChildren(groups[0]);
    assert.equal(leaf.label, 'removes a row');
    assert.equal(leaf.description, 'checkout.page.ts:5');
    assert.equal(leaf.icon, 'error');
    assert.equal(leaf.failure.testCaseId, 3);
    assert.equal(leaf.failure.uri, pageObject.toString());
  },

  async 'Re-run the failing tests runs them'() {
    await vscode.commands.executeCommand('piwi.rerunFailing');
    await vscode.commands.executeCommand('piwi.runTest', { uri: pageObject.toString(), testIds: [3] });
  },

  async 'a breakpoint pauses the run it starts, and a pick there replaces the locator of its line'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'checkout.spec.ts'));
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(spec, new vscode.Position(2, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    try {
      await vscode.commands.executeCommand('piwi.runTests', { uri: spec.toString(), testIds: [1] });
      const run = api.lastRun();
      assert.equal(run.env.PIWI_PAUSE_AT, 'tests/checkout.spec.ts:3');
      // Built in the editor from the instance's args; the instance's own command text is never run.
      assert.equal(run.command, 'npx playwright test tests/checkout.spec.ts:3 --headed');
      assert.match(run.env.PIWI_EDITOR_SEND, /^http:\/\/127\.0\.0\.1:\d+\/piwi\/send#[\w-]{16,}$/);

      const [url, token] = run.env.PIWI_EDITOR_SEND.split('#');
      const picked = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'locator',
          text: "getByTestId('cart-row')",
          at: { file: 'tests/pages/checkout.page.ts', line: 5 },
        }),
      });
      assert.equal(picked.status, 200, await picked.clone().text());
      const document = await vscode.workspace.openTextDocument(pageObject);
      assert.equal(document.lineAt(4).text, "  row = () => this.page.getByTestId('cart-row');");
    } finally {
      vscode.debug.removeBreakpoints([breakpoint]);
      await vscode.window.showTextDocument(pageObject);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  },

  async 'a test paused in a run records from there, its steps written above the paused line'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const channel = api.lastRun().env.PIWI_RECORD_CHANNEL;
    assert.ok(channel, 'the run names the record channel');
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'admin.spec.ts'));
    // The test's half of the hand-off, as the capture fixtures play it: paused before line 4.
    const { socket, heard, send } = handoff(channel, {
      file: spec.fsPath,
      line: 4,
      reason: 'breakpoint',
      testIdAttribute: null,
      baseURL: 'http://localhost:3000',
    });
    try {
      const load = await waitFor(() => heard.find((m) => m.type === 'load'), 'the editor taking the recording');
      assert.match(load.bundle, /record-ide\.js$/);
      send({ type: 'loaded' });
      const event = (call, value) =>
        send({
          type: 'binding',
          call,
          outside: false,
          payload: { kind: 'message', message: { type: 'piwi-append-recording-event', event: value } },
        });
      const at = 'http://localhost:3000/admin/orders';
      event(1, { kind: 'navigate', target: null, value: at, pageUrl: at, timestamp: 1 });
      const approve = {
        tagName: 'button',
        role: 'button',
        accessibleName: 'Approve',
        testId: null,
        text: 'Approve',
        alternatives: [{ locator: "getByRole('button', { name: 'Approve' })", method: 'getByRole', score: 90 }],
      };
      event(2, { kind: 'click', target: approve, value: null, pageUrl: at, timestamp: 2 });
      const document = await vscode.workspace.openTextDocument(spec);
      await waitFor(
        () => document.getText().includes("getByRole('button', { name: 'Approve' }).click();"),
        'the recorded step in admin.spec.ts',
      );
      const lines = document.getText().split('\n');
      assert.match(lines[3], /^  await \w+\.getByRole\('button', \{ name: 'Approve' \}\)\.click\(\);$/);
      assert.equal(lines[4], "  await adminPage.goto('/admin/orders');");
      assert.ok(!document.getText().includes(`goto('${at}')`), 'no navigation to where the recording began');
      await vscode.commands.executeCommand('piwi.stopRecording');
      await waitFor(() => heard.some((m) => m.type === 'stop'), 'the stop sent to the test');
    } finally {
      socket.destroy();
      await vscode.window.showTextDocument(spec);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  },

  async 'a run started here shows where it stops, its controls steer it, and its breakpoints follow the editor’s'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const channel = api.lastRun().env.PIWI_RUN_CHANNEL;
    assert.ok(channel, 'the run names the run channel');
    const ref = 'ed-0000c0de';
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'checkout.spec.ts'));
    // A worker of the run, as the capture fixtures play it on its run connection.
    const { socket, heard, send, heardOne } = runWorker(channel, ref);
    const sessionOf = () => api.runSessions().find((s) => s.ref === ref);
    const pausedLenses = (uri) => stopLenses(uri, '$(debug-pause) Paused · ');
    send({
      type: 'test-begin',
      testId: 't1',
      title: ['pays'],
      file: 'tests/checkout.spec.ts',
      line: 3,
      project: 'chromium',
      retry: 1,
      cannotPause: null,
    });
    try {
      await waitFor(() => sessionOf()?.workers[0]?.state === 'running', 'the running test');
      await vscode.commands.executeCommand('piwi.pauseRun');
      await heardOne('the pause', (m) => m.type === 'control' && m.action === 'pause');
      send({
        type: 'stopped',
        stop: 1,
        reason: 'pause',
        title: "Click getByRole('button', { name: 'Pay now' })",
        place: { file: 'tests/pages/checkout.page.ts', line: 4, column: 23 },
        locator: "getByRole('button', { name: 'Pay now' })",
        bar: true,
      });
      // The file opens at the paused line, marked, with what is about to run and the controls above it.
      await waitFor(() => api.executionPoints(pageObject.toString()).includes(3), 'the execution point');
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor?.document.uri.toString(), pageObject.toString());
      assert.equal(editor.selection.active.line, 3);
      const lenses = await waitFor(async () => {
        const titles = await pausedLenses(pageObject);
        return titles.length ? titles : null;
      }, 'the paused line’s lenses');
      for (const title of [
        "$(debug-pause) Paused · Click getByRole('button', { name: 'Pay now' }) · attempt 2",
        'Resume',
        'Step',
        'Run to cursor',
        'Finish',
      ]) {
        assert.ok(lenses.includes(title), lenses.join(' | '));
      }
      await vscode.commands.executeCommand('piwi.stepRun');
      await heardOne('the step', (m) => m.type === 'control' && m.action === 'step' && m.stop === 1);

      // Two lines written above the stop: the mark and its lenses follow the line, the run's code did not move.
      const pageEditor = await vscode.window.showTextDocument(pageObject);
      await pageEditor.edit((b) => b.insert(new vscode.Position(0, 0), '// one\n// two\n'));
      await waitFor(() => api.executionPoints(pageObject.toString()).includes(5), 'the execution point after the edit');
      await waitFor(async () => {
        const lenses = (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', pageObject)) ?? [];
        return lenses.find((l) => l.command?.title.startsWith('$(debug-pause) Paused · '))?.range.start.line === 5
          ? true
          : null;
      }, 'the paused line’s lens after the edit');
      // Run to cursor in the edited file: the cursor's line as the run's code has it.
      pageEditor.selection = new vscode.Selection(6, 0, 6, 0);
      await vscode.commands.executeCommand('piwi.runToCursor');
      await heardOne(
        'the run to a line of the edited file',
        (m) => m.type === 'run-to' && m.place.file === 'tests/pages/checkout.page.ts' && m.place.line === 5,
      );
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await waitFor(
        () => api.executionPoints(pageObject.toString()).includes(3),
        'the execution point after the revert',
      );

      // A breakpoint set while the run goes on reaches its worker, and so does its removal.
      const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(spec, new vscode.Position(2, 0)));
      vscode.debug.addBreakpoints([breakpoint]);
      try {
        await heardOne(
          'the breakpoint',
          (m) => m.type === 'breakpoints' && m.places.some((p) => p.file === 'tests/checkout.spec.ts' && p.line === 3),
        );
      } finally {
        const before = heard.length;
        vscode.debug.removeBreakpoints([breakpoint]);
        await waitFor(
          () => heard.slice(before).some((m) => m.type === 'breakpoints' && !m.places.length),
          'the breakpoint removed',
        );
      }

      // A breakpoint that only moves with an edit keeps the line the run has: the editor sends nothing.
      const specEditor = await vscode.window.showTextDocument(spec);
      const kept = new vscode.SourceBreakpoint(new vscode.Location(spec, new vscode.Position(2, 0)));
      let before = heard.length;
      vscode.debug.addBreakpoints([kept]);
      await waitFor(
        () => heard.slice(before).some((m) => m.type === 'breakpoints' && m.places.some((p) => p.line === 3)),
        'the breakpoint to keep',
      );
      before = heard.length;
      await specEditor.edit((b) => b.insert(new vscode.Position(0, 0), '// one\n// two\n'));
      await waitFor(
        () => vscode.debug.breakpoints.find((b) => b.id === kept.id)?.location.range.start.line === 4,
        'the breakpoint moved with the edit',
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(
        heard.slice(before).filter((m) => m.type === 'breakpoints'),
        [],
        'a breakpoint that only moved is not sent again',
      );
      vscode.debug.removeBreakpoints([kept]);
      await waitFor(
        () => heard.slice(before).some((m) => m.type === 'breakpoints' && !m.places.length),
        'the kept breakpoint removed',
      );

      // Run to cursor: the caret's line of the edited spec, the line the run's code has.
      specEditor.selection = new vscode.Selection(4, 0, 4, 0);
      await vscode.commands.executeCommand('piwi.runToCursor');
      await heardOne(
        'the run to the cursor',
        (m) => m.type === 'run-to' && m.stop === 1 && m.place.file === 'tests/checkout.spec.ts' && m.place.line === 3,
      );
      send({ type: 'running', stop: 1 });
      await waitFor(() => sessionOf()?.workers[0]?.state === 'running', 'the test going on');
      assert.deepEqual(await pausedLenses(pageObject), []);

      // A stop no pause bar shows: an image of its page beside the editor.
      send({
        type: 'stopped',
        stop: 2,
        reason: 'breakpoint',
        title: 'Fill "one" locator(\'input\')',
        place: { file: 'tests/checkout.spec.ts', line: 3 },
        locator: "locator('input')",
        bar: false,
      });
      const request = await heardOne('the image asked', (m) => m.type === 'request' && m.what === 'image');
      send({
        type: 'answer',
        request: request.request,
        what: 'image',
        value: { mime: 'image/jpeg', data: '/9j/4AAQ' },
      });
      const shown = await waitFor(() => (api.pausedPage()?.image ? api.pausedPage() : null), 'the paused page');
      assert.equal(shown.image.data, '/9j/4AAQ');
      // A reporter that does not take `pick-at` offers no pick on its image.
      assert.equal(shown.pick, null);
      // The stop's line in the spec as it stands, two lines below the run's.
      assert.equal(shown.caption, 'Paused · Fill "one" locator(\'input\') · attempt 2 · checkout.spec.ts:5');
      assert.deepEqual(api.executionPoints(spec.toString()), [4]);
      await vscode.commands.executeCommand('piwi.resumeRun');
      await heardOne('the resume', (m) => m.type === 'control' && m.action === 'resume' && m.stop === 2);
      // A second Resume for the stop that went on reaches nothing.
      await vscode.commands.executeCommand('piwi.resumeRun', { ref, worker: 0, since: 'gone' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(heard.filter((m) => m.type === 'control' && m.action === 'resume').length, 1);
    } finally {
      socket.destroy();
      await vscode.window.showTextDocument(spec);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    // The worker left: the run ends a few seconds later, and its execution point and page go with it.
    await waitFor(() => !sessionOf(), 'the end of the run');
    assert.deepEqual(api.executionPoints(spec.toString()), []);
    assert.equal(api.pausedPage()?.caption, 'The run ended.');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  async 'a run started in a terminal follows the window with its breakpoints, and ends there at End the test'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const channel = api.lastRun().env.PIWI_RUN_CHANNEL;
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'checkout.spec.ts'));
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(spec, new vscode.Position(2, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    // The run a terminal started names itself, on the channel of the window's discovery file.
    const ref = 'terminal-4242-1730000000000';
    // Once the service heard the breakpoint.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { socket, send, heardOne } = runWorker(channel, ref, ['end']);
    const sessionOf = () => api.runSessions().find((s) => s.ref === ref);
    try {
      // It starts with the editor's breakpoints, as lines of the files as they stand.
      await heardOne(
        'the editor’s breakpoints',
        (m) => m.type === 'breakpoints' && m.places.some((p) => p.file === 'tests/checkout.spec.ts' && p.line === 3),
      );
      assert.equal((await waitFor(() => sessionOf(), 'the terminal’s run')).terminal, true);
      send({
        type: 'test-begin',
        testId: 't1',
        title: ['pays'],
        file: 'tests/checkout.spec.ts',
        line: 3,
        project: 'chromium',
        retry: 0,
        cannotPause: null,
      });
      send({
        type: 'stopped',
        stop: 1,
        reason: 'breakpoint',
        title: 'Fill "one" locator(\'input\')',
        place: { file: 'tests/checkout.spec.ts', line: 3 },
        locator: "locator('input')",
        bar: true,
      });
      const lenses = await waitFor(async () => {
        const titles = await stopLenses(spec, '$(debug-pause) Paused · ');
        return titles.length ? titles : null;
      }, 'the terminal run’s lenses');
      const title = '$(debug-pause) Paused · Fill "one" locator(\'input\') · run in a terminal';
      assert.ok(lenses.includes(title), lenses.join(' | '));
      assert.ok(lenses.includes('End test'), lenses.join(' | '));
      await vscode.commands.executeCommand('piwi.endTest');
      await heardOne('End the test', (m) => m.type === 'control' && m.action === 'end' && m.stop === 1);
    } finally {
      vscode.debug.removeBreakpoints([breakpoint]);
      socket.destroy();
    }
    await waitFor(() => !sessionOf(), 'the end of the terminal’s run');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  async 'code from a stop: Assert and Mock write above the stopped line, the cursor’s locator is counted, and a failure stops'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const run = api.lastRun();
    const ref = 'ed-0000c0d3';
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'coupon.spec.ts'));
    const takes = ['pick', 'record', 'assert', 'assert-region', 'requests', 'mock', 'locator'];
    const worker = runWorker(run.env.PIWI_RUN_CHANNEL, ref, takes);
    const { send, heard, heardOne, answers } = worker;
    // Every count on the stopped page finds two elements.
    answers.locator = { ok: true, message: '2 elements match.', count: 2 };
    const stopOf = () => api.runSessions().find((s) => s.ref === ref)?.workers[0]?.stop;
    send({
      type: 'test-begin',
      testId: 't2',
      title: ['applies a coupon'],
      file: 'tests/coupon.spec.ts',
      line: 3,
      project: 'chromium',
      retry: 0,
      cannotPause: null,
    });
    send({
      type: 'stopped',
      stop: 1,
      reason: 'breakpoint',
      title: 'Fill "MORNING10" getByLabel(\'Coupon code\')',
      place: { file: 'tests/coupon.spec.ts', line: 5, column: 34 },
      locator: "getByLabel('Coupon code')",
      bar: true,
    });
    let check = null;
    try {
      await waitFor(() => api.executionPoints(spec.toString()).includes(4), 'the execution point');
      const since = stopOf().since;
      const lenses = await waitFor(async () => {
        const titles = await stopLenses(spec, '$(debug-pause) Paused · ');
        return titles.length ? titles : null;
      }, 'the paused line’s lenses');
      for (const title of ['Pick', 'Record', 'Assert', 'Assert region', 'Mock']) {
        assert.ok(lenses.includes(title), lenses.join(' | '));
      }

      // The cursor on the stopped line: its locator counted on the stopped page, at the line's end.
      const asked = await heardOne('the count asked', (m) => m.type === 'request' && m.what === 'locator');
      assert.equal(asked.locator, "getByLabel('Coupon code')");
      const count = await waitFor(() => api.caretCount(), 'the count at the cursor');
      assert.deepEqual(count, { uri: spec.toString(), line: 4, text: '2 matches', brief: false });

      // Assert: the check made in the test's window, written above the stopped line with the import it needs.
      const target = { ref, worker: 0, since };
      const asserting = vscode.commands.executeCommand('piwi.assertAtStop', target);
      const intent = await heardOne('the check asked', (m) => m.type === 'request' && m.what === 'assert');
      send({
        type: 'answer',
        request: intent.request,
        what: 'assert',
        value: { ok: true, message: "Check an element in the test's window." },
      });
      await asserting;
      check = handoff(run.env.PIWI_RECORD_CHANNEL, {
        file: spec.fsPath,
        line: 5,
        reason: 'breakpoint',
        testIdAttribute: null,
        baseURL: 'http://localhost:3000',
        mode: 'check',
        stop: { ref, worker: 0, stop: 1 },
      });
      await waitFor(() => check.heard.find((m) => m.type === 'load'), 'the check panel loaded');
      check.send({ type: 'loaded' });
      const total = {
        tagName: 'output',
        role: 'status',
        accessibleName: null,
        testId: 'total',
        text: 'Total €72.00',
        alternatives: [{ locator: "getByTestId('total')", method: 'getByTestId', score: 90 }],
      };
      check.send({
        type: 'binding',
        call: 1,
        outside: false,
        payload: {
          kind: 'message',
          message: {
            type: 'piwi-append-recording-event',
            event: {
              kind: 'assert',
              target: total,
              value: null,
              checked: null,
              inputType: null,
              isPasswordField: false,
              pageUrl: 'http://localhost:3000/cart',
              timestamp: 1,
              assertion: { matcher: 'toHaveText', expected: 'Total €72.00', actual: null, negated: false, note: null },
            },
          },
        },
      });
      const document = await vscode.workspace.openTextDocument(spec);
      await waitFor(() => document.getText().includes('toHaveText('), 'the check written');
      let lines = document.getText().split('\n');
      assert.equal(lines[1], "import { expect } from '@playwright/test';");
      assert.equal(lines[5], "  await expect(page.getByTestId('total')).toHaveText('Total €72.00');");
      assert.equal(lines[6], "  await page.getByLabel('Coupon code').fill('MORNING10');");
      assert.equal(document.isDirty, true);
      // The mark follows the stopped statement down.
      await waitFor(() => api.executionPoints(spec.toString()).includes(6), 'the execution point below the check');
      // One undo step: Undo takes the check and its import away, Redo writes them again.
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('undo');
      assert.ok(!document.getText().includes('expect'), document.getText());
      await vscode.commands.executeCommand('redo');
      assert.equal(document.lineAt(5).text, lines[5]);
      await waitFor(() => api.executionPoints(spec.toString()).includes(6), 'the execution point after the redo');

      // Mock a request: the responses the test kept, the one chosen written above the stopped statement, which the
      // service follows through the check and its import.
      const kept = {
        id: 1,
        method: 'GET',
        url: 'http://localhost:3000/api/cart',
        status: 200,
        type: 'application/json',
        size: 12,
        time: 840,
      };
      const before = heard.length;
      const mocking = vscode.commands.executeCommand('piwi.mockAtStop', target);
      const listing = await heardOne(
        'the responses asked',
        (m) => m.type === 'request' && m.what === 'requests',
        before,
      );
      send({
        type: 'answer',
        request: listing.request,
        what: 'requests',
        value: { ok: true, message: 'The test kept 1 response.', requests: [kept] },
      });
      // The list shows: its only response is chosen.
      const mock = await waitFor(async () => {
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        return heard.slice(before).find((m) => m.type === 'request' && m.what === 'mock');
      }, 'the response chosen');
      assert.equal(mock.id, 1);
      send({
        type: 'answer',
        request: mock.request,
        what: 'mock',
        value: {
          ok: true,
          message: 'GET',
          response: { method: 'GET', url: kept.url, status: 200, type: 'application/json', body: '{"items":[]}' },
        },
      });
      await mocking;
      await waitFor(() => document.getText().includes('page.route('), 'the mock written');
      lines = document.getText().split('\n');
      const route = lines.indexOf("  await page.route('**/api/cart', (route) =>");
      assert.ok(route > 5, lines.join('\n'));
      assert.equal(lines[route - 1], "  await expect(page.getByTestId('total')).toHaveText('Total €72.00');");
      assert.equal(lines[route + 7], "  await page.getByLabel('Coupon code').fill('MORNING10');");
      assert.equal(lines.filter((l) => l.startsWith('import ')).length, 2, 'the mock needs no import');

      // A failure the bar holds: its own line, Resume alone among the controls, and the code actions.
      send({ type: 'running', stop: 1 });
      await waitFor(() => !stopOf(), 'the test going on');
      assert.equal(api.caretCount(), null);
      send({
        type: 'stopped',
        stop: 2,
        reason: 'failure',
        title: "Failed: Timed out 5000ms waiting for getByRole('button', { name: 'Apply' })",
        place: { file: 'tests/coupon.spec.ts', line: 6, column: 52 },
        locator: "getByRole('button', { name: 'Apply' })",
        bar: true,
      });
      const failed = await waitFor(async () => {
        const titles = await stopLenses(spec, '$(error) Failed · ');
        return titles.length ? titles : null;
      }, 'the failure’s lenses');
      assert.deepEqual(failed, [
        "$(error) Failed · Timed out 5000ms waiting for getByRole('button', { name: 'Apply' })",
        'Resume',
        'Pick',
        'Record',
        'Assert',
        'Assert region',
        'Mock',
      ]);
      const from = heard.length;
      await vscode.commands.executeCommand('piwi.resumeRun');
      await heardOne('the resume', (m) => m.type === 'control' && m.action === 'resume' && m.stop === 2, from);
    } finally {
      check?.socket.destroy();
      worker.socket.destroy();
      await vscode.window.showTextDocument(spec);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await waitFor(() => !api.runSessions().some((s) => s.ref === ref), 'the end of the run');
  },

  async 'a click on a headless stop’s image picks the element under it, and its locator replaces the stopped line’s'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const run = api.lastRun();
    const ref = 'ed-0000c0d4';
    const spec = vscode.Uri.file(path.join(workspace, 'tests', 'coupon.spec.ts'));
    const worker = runWorker(run.env.PIWI_RUN_CHANNEL, ref, ['pick', 'record', 'locator', 'view', 'input', 'pick-at']);
    const { send, heardOne } = worker;
    send({
      type: 'test-begin',
      testId: 't3',
      title: ['applies a coupon'],
      file: 'tests/coupon.spec.ts',
      line: 3,
      project: 'chromium',
      retry: 0,
      cannotPause: null,
    });
    send({
      type: 'stopped',
      stop: 1,
      reason: 'pause',
      title: 'Fill "MORNING10" getByLabel(\'Coupon code\')',
      place: { file: 'tests/coupon.spec.ts', line: 5, column: 34 },
      locator: "getByLabel('Coupon code')",
      bar: false,
    });
    try {
      // The image names the page's viewport, 1280 by 800 CSS pixels.
      const asked = await heardOne('the image asked', (m) => m.type === 'request' && m.what === 'image');
      send({
        type: 'answer',
        request: asked.request,
        what: 'image',
        value: { mime: 'image/jpeg', data: '/9j/4AAQ', width: 1280, height: 800 },
      });
      const shown = await waitFor(() => api.pausedPage()?.pick, 'the image a click picks on');
      // A click on an image the view no longer shows picks nothing.
      await api.pickOnPage({ type: 'pick', shown: shown.shown - 1, x: 10, y: 10, width: 640, height: 400 });
      // The image shown at 640 by 400: a click at 320, 100 of it is the page's 640, 200.
      const picking = api.pickOnPage({ type: 'pick', shown: shown.shown, x: 320, y: 100, width: 640, height: 400 });
      const pick = await heardOne('the pick on the image', (m) => m.type === 'request' && m.what === 'pick-at');
      assert.deepEqual([pick.stop, pick.x, pick.y], [1, 640, 200]);
      assert.equal(worker.heard.filter((m) => m.what === 'pick-at').length, 1);
      // The worker sends the locator where the bar's pick goes, then answers.
      const [url, token] = run.env.PIWI_EDITOR_SEND.split('#');
      const posted = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'locator',
          text: "getByRole('textbox', { name: 'Coupon code' })",
          at: { file: 'tests/coupon.spec.ts', line: 5 },
        }),
      });
      assert.equal(posted.status, 200, await posted.clone().text());
      const message =
        "getByRole('textbox', { name: 'Coupon code' }) went to the editor, in place of the locator on the stopped line.";
      send({
        type: 'answer',
        request: pick.request,
        what: 'pick-at',
        value: { ok: true, message, locator: "getByRole('textbox', { name: 'Coupon code' })" },
      });
      await picking;
      assert.equal(api.pausedPage().note, message);
      const document = await vscode.workspace.openTextDocument(spec);
      assert.equal(
        document.lineAt(4).text,
        "  await page.getByRole('textbox', { name: 'Coupon code' }).fill('MORNING10');",
      );
    } finally {
      worker.socket.destroy();
      await vscode.window.showTextDocument(spec);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await waitFor(() => !api.runSessions().some((s) => s.ref === ref), 'the end of the run');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  async 'a C# file shows the lines its tests ran, its functions’ tests, and the marks hide and show again'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const basket = vscode.Uri.file(path.join(workspace, 'src', 'Web', 'Services', 'BasketService.cs'));
    await vscode.window.showTextDocument(basket);
    const held = await waitFor(() => {
      const found = api.coverage(basket.toString());
      return found?.result.state === 'exact' ? found : null;
    }, 'the coverage marks');
    assert.equal(held.shown, true);
    assert.deepEqual(held.result.executed, [
      { start: 3, end: 4, tests: 2 },
      { start: 8, end: 9, tests: 2 },
    ]);
    assert.deepEqual(held.result.notRun, [{ start: 6, end: 6 }]);
    const lenses = await waitFor(async () => {
      const found = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', basket);
      return found?.length >= 2 ? found : null;
    }, 'the coverage lenses');
    const titles = lenses.map((l) => l.command?.title);
    assert.ok(titles.includes('Reached by 2 tests · 1 failing · 4 of 5 lines run'), titles.join(' | '));
    assert.ok(titles.includes('Reached by 2 tests · 1 failing'), titles.join(' | '));
    const hover = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      basket,
      new vscode.Position(3, 8),
    );
    const text = hover.map((h) => h.contents.map((c) => c.value ?? c).join('\n')).join('\n');
    assert.match(text, /run by 2 tests/);
    await vscode.commands.executeCommand('piwi.toggleCoverage');
    assert.equal(api.coverage(basket.toString()).shown, false);
    await vscode.commands.executeCommand('piwi.toggleCoverage');
    assert.equal(api.coverage(basket.toString()).shown, true);
  },

  async 'the MCP configuration carries the key, or none once the agent is set to sign in'() {
    const copied = async () => {
      await vscode.commands.executeCommand('piwi.copyMcpConfiguration');
      return JSON.parse(await vscode.env.clipboard.readText()).servers.piwi;
    };
    assert.deepEqual((await copied()).headers, { Authorization: 'Bearer pd_integration' });
    const settings = vscode.workspace.getConfiguration('piwi');
    await settings.update('mcpAuthorization', 'sign-in', vscode.ConfigurationTarget.Global);
    try {
      const signIn = await waitFor(async () => {
        const server = await copied();
        return server.headers ? null : server;
      }, 'the configuration without the key');
      assert.equal(signIn.type, 'http');
      assert.match(signIn.url, /\/mcp$/);
    } finally {
      await settings.update('mcpAuthorization', undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(async () => (await copied()).headers, 'the key again');
  },

  async 'the commands are registered'() {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'piwi.connect',
      'piwi.disconnect',
      'piwi.openSettings',
      'piwi.getStarted',
      'piwi.refresh',
      'piwi.refreshRun',
      'piwi.runTestsForFile',
      'piwi.openInDashboard',
      'piwi.openRun',
      'piwi.openTrace',
      'piwi.runTests',
      'piwi.runTest',
      'piwi.rerunFailing',
      'piwi.groupFailuresBy',
      'piwi.compareWith',
      'piwi.toggleFollowEditor',
      'piwi.toggleCoverage',
      'piwi.copyAgentContext',
      'piwi.copyMcpConfiguration',
      'piwi.pairPicker',
      'piwi.runCommand',
      'piwi.copyText',
      'piwi.runSelection',
      'piwi.record',
      'piwi.recordFile',
      'piwi.stopRecording',
      'piwi.pauseRecording',
      'piwi.resumeRecording',
      'piwi.pauseRun',
      'piwi.stopRun',
      'piwi.resumeRun',
      'piwi.stepRun',
      'piwi.runToCursor',
      'piwi.finishRun',
      'piwi.endTest',
      'piwi.showPausedPage',
      'piwi.pickAtStop',
      'piwi.recordAtStop',
      'piwi.assertAtStop',
      'piwi.assertRegionAtStop',
      'piwi.mockAtStop',
      'piwi.codeAtStop',
      'piwi.shareWithPlaywright',
      'piwi.copyRunsMcpConfiguration',
    ]) {
      assert.ok(commands.includes(id), id);
    }
    await vscode.commands.executeCommand('piwi.refresh');
    await vscode.commands.executeCommand('piwi.refreshRun');
  },

  async 'the runs are served to agents behind the window’s token, and stop with the setting'() {
    const api = vscode.extensions.getExtension('piwitests.piwi').exports;
    const served = await waitFor(() => api.agents(), 'the runs’ MCP server');
    assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const ask = (token, body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) =>
      fetch(served.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const listed = await (
      await ask(served.token).catch((e) => {
        throw new Error(`${served.url}: ${e.cause?.message ?? e.cause ?? e}`);
      })
    ).json();
    assert.deepEqual(
      listed.result.tools.map((t) => t.name),
      ['run_list', 'run_follow', 'run_control', 'page_snapshot', 'page_act', 'page_locator', 'code_write'],
    );
    assert.equal((await ask('x'.repeat(43))).status, 401);
    await vscode.commands.executeCommand('piwi.copyRunsMcpConfiguration', 'vscode');
    const copied = JSON.parse(await vscode.env.clipboard.readText());
    const entry = { type: 'http', url: served.url, headers: { Authorization: `Bearer ${served.token}` } };
    assert.deepEqual(copied.servers['piwi-runs'], entry);
    await vscode.commands.executeCommand('piwi.copyRunsMcpConfiguration', 'mcpServers');
    assert.deepEqual(JSON.parse(await vscode.env.clipboard.readText()).mcpServers['piwi-runs'], entry);
    const settings = vscode.workspace.getConfiguration('piwi');
    await settings.update('serveRunsToAgents', false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => api.agents() === null, 'the runs’ MCP server to stop');
      await assert.rejects(ask(served.token));
    } finally {
      await settings.update('serveRunsToAgents', undefined, vscode.ConfigurationTarget.Workspace);
    }
    const again = await waitFor(() => api.agents(), 'the runs’ MCP server again');
    assert.equal(again.token, served.token);
    assert.equal((await ask(again.token)).status, 200);
    // Reset the token: a new one, served at once, the one before refused.
    await vscode.commands.executeCommand('piwi.resetRunsMcpToken', true);
    const reset = await waitFor(() => (api.agents()?.token !== served.token ? api.agents() : null), 'a new token');
    assert.equal(reset.url, served.url);
    assert.equal((await ask(served.token)).status, 401);
    assert.equal((await ask(reset.token)).status, 200);
  },
};

exports.run = async function run() {
  const failures = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack : e}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
};
