#!/usr/bin/env node
// Captures the plugin's illustrations for the docs site and the Marketplace listing: the latest WebStorm release,
// downloaded into `.ide/` on the first run, opens the fixture project of apps/vscode/scripts/lib/editor-fixture.mjs
// with the built plugin against the stub Piwi instance served from this process, on an Xvfb display this script
// starts. Each scene is one launch of the IDE with its file and line on the command line, which is what puts the
// caret there with the editor focused; the keys a scene then needs go through `xinput.py` (XTEST) and the shortcuts
// of a keymap this script writes, and ImageMagick's `import` captures the screen. The images are rendered at 2×
// (`sun.java2d.uiScale`) and written at the window's width, 1440 px, to apps/docs/public/screenshots/jetbrains-<scene>.png.
//
//   npm run editor:build -w packages/editor && (cd apps/jetbrains && ./gradlew buildPlugin)
//   node scripts/take-screenshots.mjs [--out <dir>] [--scene <name>…] [--ide <WebStorm directory>] [--probe] [--keep]
//
// The IDE keeps its config directory in `.ide/config` across runs, because the license lives there: on a machine with
// none, `--start-trial` answers the license dialog's Start trial tab, which claims WebStorm's 30-day trial for this
// IDE version on this machine with no account (an internet connection is all it needs; a version's trial is claimed
// once per machine), and `--config <dir>` copies an activated IDE's config directory in instead. An EAP build asks
// for a JetBrains account, so it cannot serve. `--ide` names another installed release. `--probe` only opens the
// page object at its failing line, waits, captures the screen as it stands and exits: the way to look at what the
// IDE shows before a scene drives it. `--keep` leaves the run's temporary directory, with the IDE's logs.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  FAILING_LINE,
  PAGE_OBJECT_FILE,
  PROJECT,
  SPEC_FILE,
  startStub,
  writeWorkspace,
} from '../../vscode/scripts/lib/editor-fixture.mjs';
import { cutWindow, writeAtWidth } from '../../vscode/scripts/lib/image.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const DEFAULT_OUT = path.join(repoRoot, 'apps', 'docs', 'public', 'screenshots');
const WINDOW = { width: 1440, height: 900 };
const SCALE = 2;
const DISPLAY = ':77';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const outDir = path.resolve(option('--out') ?? DEFAULT_OUT);
const only = args.filter((a, i) => args[i - 1] === '--scene');
const probe = args.includes('--probe');
/** An activated IDE's config directory, copied so the IDE starts licensed. */
const configFrom = option('--config') ? path.resolve(option('--config')) : undefined;
const startTrial = args.includes('--start-trial');

/** Where the downloaded IDE lives, beside the Gradle sandbox: gitignored. */
const IDE_DIR = path.join(pluginRoot, '.ide');

/**
 * The shortcuts the scenes press, bound by the keymap this script writes: the IDE's actions have none of their own
 * for these, and a shortcut is deterministic where a click on the tool window's button or a search for the action
 * is not. The chords are spelled as the keymap and as `xinput.py` take them.
 */
const KEYS = {
  piwiToolWindow: { action: 'ActivatePiwiToolWindow', keymap: 'shift ctrl alt F10', xinput: 'shift+ctrl+alt+F10' },
  clearNotifications: {
    action: 'ClearAllNotifications',
    keymap: 'shift ctrl alt F11',
    xinput: 'shift+ctrl+alt+F11',
  },
  hideToolWindows: { action: 'HideAllWindows', keymap: 'shift ctrl alt F12', xinput: 'shift+ctrl+alt+F12' },
};

/**
 * The IDE to run: `--ide`, else the latest WebStorm release, downloaded into `.ide/` once from JetBrains' releases
 * API (the Linux tar.gz, about 1 GB) and kept.
 */
async function findIde() {
  if (option('--ide')) return path.resolve(option('--ide'));
  const isIde = (name) => /^WebStorm-/.test(name) && fs.existsSync(path.join(IDE_DIR, name, 'bin', 'webstorm.sh'));
  const installed = fs.existsSync(IDE_DIR) ? fs.readdirSync(IDE_DIR).filter(isIde).sort() : [];
  if (installed.length) return path.join(IDE_DIR, installed.at(-1));
  const releases = await fetch(
    'https://data.services.jetbrains.com/products/releases?code=WS&latest=true&type=release',
  );
  if (!releases.ok) throw new Error(`JetBrains' releases API answered ${releases.status}`);
  const release = (await releases.json()).WS?.[0];
  const link = release?.downloads?.linux?.link;
  if (!link) throw new Error('The latest WebStorm release has no Linux download.');
  console.log(
    `downloading WebStorm ${release.version} (${release.build}) into ${path.relative(process.cwd(), IDE_DIR)}…`,
  );
  fs.mkdirSync(IDE_DIR, { recursive: true });
  const archive = path.join(IDE_DIR, path.basename(new URL(link).pathname));
  const download = await fetch(link);
  if (!download.ok || !download.body) throw new Error(`The WebStorm download answered ${download.status}`);
  await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(archive));
  execFileSync('tar', ['-xzf', archive, '-C', IDE_DIR]);
  fs.rmSync(archive, { force: true });
  const unpacked = fs.readdirSync(IDE_DIR).filter(isIde).sort();
  if (!unpacked.length) throw new Error('The WebStorm archive held no WebStorm-* directory.');
  return path.join(IDE_DIR, unpacked.at(-1));
}

/** The built plugin, unpacked into a plugins directory of its own. */
function unpackPlugin(into) {
  const dist = path.join(pluginRoot, 'build', 'distributions');
  const zip = fs.existsSync(dist) ? fs.readdirSync(dist).find((f) => /^piwi-jetbrains-.*\.zip$/.test(f)) : undefined;
  if (!zip) throw new Error('The plugin is not built: run `./gradlew buildPlugin` first.');
  fs.mkdirSync(into, { recursive: true });
  execFileSync('unzip', ['-q', path.join(dist, zip), '-d', into]);
}

/** The project's IDE state: the window's size, the project tree open on the tests, the Piwi tool window below. */
function writeIdeaState(workspace) {
  const idea = path.join(workspace, '.idea');
  fs.mkdirSync(idea, { recursive: true });
  fs.writeFileSync(path.join(idea, '.gitignore'), '*\n');
  fs.writeFileSync(
    path.join(idea, 'workspace.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectFrameBounds" extendedState="0">
    <option name="x" value="0" />
    <option name="y" value="0" />
    <option name="width" value="${WINDOW.width}" />
    <option name="height" value="${WINDOW.height}" />
  </component>
  <component name="ProjectView">
    <navigator proportions="" version="1">
      <foldersAlwaysOnTop value="true" />
    </navigator>
    <panes>
      <pane id="ProjectPane">
        <subPane>
          <expand>
            <path>
              <item name="acme-mugs" type="b2602c69:ProjectViewProjectNode" />
              <item name="acme-mugs" type="462c0819:PsiDirectoryNode" />
            </path>
            <path>
              <item name="acme-mugs" type="b2602c69:ProjectViewProjectNode" />
              <item name="acme-mugs" type="462c0819:PsiDirectoryNode" />
              <item name="tests" type="462c0819:PsiDirectoryNode" />
            </path>
            <path>
              <item name="acme-mugs" type="b2602c69:ProjectViewProjectNode" />
              <item name="acme-mugs" type="462c0819:PsiDirectoryNode" />
              <item name="tests" type="462c0819:PsiDirectoryNode" />
              <item name="pages" type="462c0819:PsiDirectoryNode" />
            </path>
          </expand>
          <select />
        </subPane>
      </pane>
    </panes>
  </component>
  <component name="ToolWindowManager">
    <frame x="0" y="0" width="${WINDOW.width}" height="${WINDOW.height}" extended-state="0" />
    <layout>
      <window_info id="Project" active="false" visible="true" weight="0.22" order="0" content_ui="combo" />
      <window_info id="Piwi" anchor="bottom" active="false" visible="false" weight="0.32" order="0" />
      <window_info id="Problems View" anchor="bottom" visible="false" order="1" />
    </layout>
  </component>
</project>
`,
  );
}

/** The IDE's own directories, under one temporary root: its settings, its caches and the built plugin. */
function writeIdeDirs(root, ide) {
  // The settings stay in `.ide/config` from run to run, with the license the IDE holds; the rest is this run's.
  const dirs = {
    config: path.join(IDE_DIR, 'config'),
    system: path.join(root, 'system'),
    plugins: path.join(root, 'plugins'),
    log: path.join(root, 'log'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  if (configFrom) fs.cpSync(configFrom, dirs.config, { recursive: true, force: true });
  unpackPlugin(dirs.plugins);
  // No AI Assistant promotion in the frame, and no JetBrains OS Integration: its daemon fails to start on a bare
  // display and reports an IDE error in the status bar.
  fs.writeFileSync(
    path.join(dirs.config, 'disabled_plugins.txt'),
    ['com.intellij.ml.llm', 'com.intellij.platform.daemon', ''].join('\n'),
  );
  const options = path.join(dirs.config, 'options');
  fs.mkdirSync(options, { recursive: true });
  fs.writeFileSync(
    path.join(options, 'ide.general.xml'),
    `<application>
  <component name="GeneralSettings">
    <option name="confirmExit" value="false" />
    <option name="showTipsOnStartup" value="false" />
  </component>
</application>
`,
  );
  fs.writeFileSync(
    path.join(options, 'updates.xml'),
    `<application>
  <component name="UpdatesConfigurable">
    <option name="CHECK_NEEDED" value="false" />
  </component>
</application>
`,
  );
  // The dark theme and the bundled fonts, as the Marketplace screenshots of most plugins show them.
  fs.writeFileSync(
    path.join(options, 'laf.xml'),
    `<application>
  <component name="LafManager" autodetect="false">
    <laf themeId="ExperimentalDark" />
  </component>
</application>
`,
  );
  // No code author hints above the declarations: the fixture's one commit would sign every line, and the summaries
  // the plugin adds above the tests are the point.
  fs.writeFileSync(
    path.join(options, 'editor.xml'),
    `<application>
  <component name="EditorSettings">
    <option name="IS_WHITESPACES_SHOWN" value="false" />
  </component>
  <component name="CodeVisionSettings">
    <option name="disabledCodeVisionProviderIds">
      <set>
        <option value="vcs.code.vision" />
      </set>
    </option>
  </component>
</application>
`,
  );
  // The scenes' shortcuts, on top of the IDE's own keymap for Linux.
  const keymaps = path.join(dirs.config, 'keymaps');
  fs.mkdirSync(keymaps, { recursive: true });
  fs.writeFileSync(
    path.join(keymaps, 'Screenshots.xml'),
    `<keymap version="1" name="Screenshots" parent="Default for XWin">
${Object.values(KEYS)
  .map(
    (key) => `  <action id="${key.action}">
    <keyboard-shortcut first-keystroke="${key.keymap}" />
  </action>`,
  )
  .join('\n')}
</keymap>
`,
  );
  fs.writeFileSync(
    path.join(options, 'keymap.xml'),
    `<application>
  <component name="KeymapManager">
    <active_keymap name="Screenshots" />
  </component>
</application>
`,
  );
  const properties = path.join(root, 'idea.properties');
  fs.writeFileSync(
    properties,
    [
      `idea.config.path=${dirs.config}`,
      `idea.system.path=${dirs.system}`,
      `idea.plugins.path=${dirs.plugins}`,
      `idea.log.path=${dirs.log}`,
      'idea.trust.all.projects=true',
      'ide.show.tips.on.startup.default.value=false',
      'ide.no.platform.update=true',
      'idea.suppress.statistics.report=true',
      'idea.initially.ask.config=never',
      'jb.consents.confirmation.enabled=false',
      'jb.privacy.policy.text=<!--999.999-->',
      'idea.is.internal=false',
      'ide.slow.operations.assertion=false',
      '',
    ].join('\n'),
  );
  // The IDE's own options, then this run's: the launcher reads one file in place of the bundled one.
  const vmoptions = path.join(root, 'webstorm.vmoptions');
  const bundled = fs.existsSync(path.join(ide, 'bin', 'webstorm64.vmoptions'))
    ? fs
        .readFileSync(path.join(ide, 'bin', 'webstorm64.vmoptions'), 'utf-8')
        .split('\n')
        .filter((l) => l && !l.startsWith('#') && !/^-Xm[sx]/.test(l))
    : [];
  fs.writeFileSync(
    vmoptions,
    [
      ...bundled,
      '-Xms512m',
      '-Xmx2048m',
      `-Dsun.java2d.uiScale=${SCALE}`,
      '-Didea.trust.all.projects=true',
      '-Djb.consents.confirmation.enabled=false',
      '-Djb.privacy.policy.text=<!--999.999-->',
      '-Didea.initially.ask.config=never',
      '-Dide.show.tips.on.startup.default.value=false',
      '-Dide.no.platform.update=true',
      '-Didea.suppress.statistics.report=true',
      '-Didea.fatal.error.notification=disabled',
      // The "got it" tooltips, among them the trial's on the status bar widget, which no notification action clears.
      '-Dide.integration.test.disable.got.it.tooltips=true',
      '-Dawt.useSystemAAFontSettings=lcd',
      '',
    ].join('\n'),
  );
  return { ...dirs, properties, vmoptions };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function xinput(...commands) {
  execFileSync('python3', [path.join(here, 'xinput.py'), ...commands.map(String)], {
    env: { ...process.env, DISPLAY },
    stdio: 'inherit',
  });
}

/** The screen as it stands, the window alone (the screen around it is black), written at the window's width. */
async function shoot(name, dir = outDir) {
  const raw = path.join(os.tmpdir(), `piwi-jetbrains-${name}-${process.pid}.png`);
  execFileSync('import', ['-display', DISPLAY, '-window', 'root', raw]);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `jetbrains-${name}.png`);
  await writeAtWidth(await cutWindow(raw), WINDOW.width, file);
  fs.rmSync(raw, { force: true });
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

/** Whether the config directory holds a license or a trial: the IDE writes it as `<product>.key`. */
function licensed(config) {
  return fs.readdirSync(config).some((name) => name.endsWith('.key'));
}

/**
 * Answers the license dialog the IDE shows before the project: with `--start-trial`, its Start trial tab and the
 * button there, at the places they take in a 1440 × 900 window at 2×; without, the run stops and says what to do.
 */
async function claimTrial(dirs) {
  if (licensed(dirs.config)) {
    throw new Error(
      'The IDE asks for a license although .ide/config holds a key: a trial is bound to the machine it was claimed ' +
        'on. Remove the key and run again with --start-trial, or pass the config directory of an activated IDE with ' +
        '--config.',
    );
  }
  if (!startTrial) {
    throw new Error(
      'The IDE asks for a license. Run again with --start-trial to claim its 30-day trial on this machine, or pass ' +
        'the config directory of an activated IDE with --config.',
    );
  }
  await sleep(8000);
  xinput('move', 1837, 476, 'sleep', 0.3, 'click', 1, 'sleep', 2.5, 'move', 1297, 801, 'sleep', 0.3, 'click', 1);
  const claimed = Date.now();
  while (!licensed(dirs.config) && Date.now() - claimed < 60_000) await sleep(2000);
  if (!licensed(dirs.config)) throw new Error('The trial did not start: is the machine online?');
  // The dialog now shows the trial; Close is where the Quit button was.
  await sleep(2000);
  xinput('move', 2197, 1430, 'sleep', 0.3, 'click', 1);
  console.log('trial started: the IDE keeps it in .ide/config');
}

/**
 * Waits until the IDE's log says the project is open and the editor service has read the stub instance (`contacted`),
 * or `ms` passed since the last step: the license dialog, which the IDE shows before the project on a machine
 * without a license, is answered on the way and the wait starts over. `failed` says whether the IDE process is gone.
 */
async function waitForIde(dirs, ms, { failed, contacted }) {
  const log = path.join(dirs.log, 'idea.log');
  let start = Date.now();
  let asked = false;
  let seen = { project: false, service: false };
  while (Date.now() - start < ms) {
    const failure = failed();
    if (failure) throw failure;
    if (fs.existsSync(log)) {
      const text = fs.readFileSync(log, 'utf-8');
      if (!asked && /License required/.test(text)) {
        asked = true;
        await claimTrial(dirs);
        start = Date.now();
      }
      seen = { project: /Project frame set to|project opened/i.test(text), service: contacted() };
      if (seen.project && seen.service) return seen;
    }
    await sleep(2000);
  }
  return seen;
}

/**
 * One launch of the IDE on the project, with `file` open at `line:column` and the editor focused, as the command
 * line puts it (the editor state of workspace.xml is not restored on a fresh project); `work` runs once the project
 * is open and the first diagnostics are in, and the IDE is stopped after it.
 */
async function withIde(run, { file, line, column }, work) {
  const { ide, root, dirs, workspace, url, contacted, reset } = run;
  reset();
  fs.rmSync(dirs.log, { recursive: true, force: true });
  fs.mkdirSync(dirs.log, { recursive: true });
  const out = path.join(root, `ide-${path.basename(file, '.ts')}.out`);
  const ideLog = fs.openSync(out, 'w');
  // JAVA_TOOL_OPTIONS would override the IDE's own options, and it says so in a notification.
  const { JAVA_TOOL_OPTIONS: _javaToolOptions, ...env } = process.env;
  // The native launcher, where the release has one; the shell script otherwise. Both read the same variables.
  const launcher = ['webstorm', 'webstorm.sh'].map((name) => path.join(ide, 'bin', name)).find((f) => fs.existsSync(f));
  const idea = spawn(
    launcher,
    [workspace, '--line', String(line), '--column', String(column), path.join(workspace, file)],
    {
      env: {
        ...env,
        DISPLAY,
        // The launcher reads these two names, whatever the product is called.
        WEBIDE_PROPERTIES: dirs.properties,
        WEBIDE_VM_OPTIONS: dirs.vmoptions,
        PIWI_DASHBOARD_URL: url,
        PIWI_PROJECT_NAME: PROJECT.name,
        PIWI_DESKTOP_CONFIG: path.join(root, 'no-desktop.json'),
      },
      stdio: ['ignore', ideLog, ideLog],
      detached: true,
    },
  );
  let spawnError;
  idea.on('error', (error) => {
    spawnError = error;
  });
  const failed = () =>
    spawnError ??
    (idea.exitCode === null ? undefined : new Error(`The IDE exited with code ${idea.exitCode}: see ${out}`));
  try {
    const seen = await waitForIde(dirs, 120_000, { failed, contacted });
    console.log(
      `IDE: project ${seen.project ? 'open' : 'not seen'}, editor service ${seen.service ? 'connected' : 'not seen'}, ${file}:${line}`,
    );
    // Indexing and the first diagnostics take a while after the project opens; then the balloons go.
    await sleep(40_000);
    xinput('key', KEYS.clearNotifications.xinput);
    await sleep(1500);
    await work();
  } finally {
    try {
      process.kill(-idea.pid, 'SIGTERM');
    } catch {}
    await sleep(4000);
    try {
      process.kill(-idea.pid, 'SIGKILL');
    } catch {}
    fs.closeSync(ideLog);
  }
}

const SCENES = {
  /**
   * The spec with the plugin's summaries above its tests, the run's failures in the Piwi tool window below, across
   * the width: the project view would show the fixture's temporary path.
   */
  failures: {
    file: SPEC_FILE,
    line: 1,
    column: 1,
    async run() {
      xinput('key', KEYS.hideToolWindows.xinput);
      await sleep(1500);
      xinput('key', KEYS.piwiToolWindow.xinput);
      await sleep(4000);
      await shoot('failures');
    },
  },

  /**
   * The page object at its failing line, Alt+Enter: the replacement locator among the quick fixes, with the edit's
   * preview beside the popup, which the editor alone leaves room for.
   */
  heal: {
    file: PAGE_OBJECT_FILE,
    line: FAILING_LINE,
    column: 5,
    async run() {
      xinput('key', KEYS.hideToolWindows.xinput);
      await sleep(1500);
      xinput('key', 'alt+Return');
      await sleep(3000);
      await shoot('heal');
      xinput('key', 'Escape');
      await sleep(500);
    },
  },
};

async function main() {
  const ide = await findIde();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-jetbrains-shots-')));
  const { workspace, commit } = writeWorkspace(root);
  writeIdeaState(workspace);
  const dirs = writeIdeDirs(root, ide);
  const { server, url } = await startStub(commit);
  // The editor service reads the stub once it runs: the sign the plugin is up, for each launch.
  let requests = 0;
  server.on('request', () => {
    requests += 1;
  });
  const xvfb = spawn(
    'Xvfb',
    [DISPLAY, '-screen', '0', `${WINDOW.width * SCALE}x${WINDOW.height * SCALE}x24`, '-nolisten', 'tcp'],
    {
      stdio: 'ignore',
    },
  );
  let xvfbFailure;
  xvfb.on('error', (error) => {
    xvfbFailure = error;
  });
  xvfb.on('exit', (code) => {
    xvfbFailure ??= new Error(`Xvfb exited with code ${code}: is the display ${DISPLAY} free?`);
  });
  await sleep(1500);
  const run = {
    ide,
    root,
    dirs,
    workspace,
    url,
    contacted: () => requests > 0,
    reset: () => {
      requests = 0;
    },
  };
  try {
    if (xvfbFailure) throw xvfbFailure;
    if (probe) {
      // The probe's capture is not an illustration: it goes to the temp directory.
      await withIde(run, SCENES.heal, () => shoot('probe', os.tmpdir()));
      return;
    }
    const unknown = only.filter((name) => !(name in SCENES));
    if (unknown.length)
      throw new Error(`Unknown scene: ${unknown.join(', ')} (the scenes: ${Object.keys(SCENES).join(', ')})`);
    const names = Object.keys(SCENES).filter((name) => only.length === 0 || only.includes(name));
    for (const name of names) await withIde(run, SCENES[name], SCENES[name].run);
  } finally {
    xvfb.kill('SIGTERM');
    server.close();
    // The config directory is not under `root`: it stays, with the license.
    if (!args.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`kept ${root}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
