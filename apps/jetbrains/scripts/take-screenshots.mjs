#!/usr/bin/env node
// Captures the plugin's illustrations for the docs site and the Marketplace listing: WebStorm, the one the Gradle
// build downloaded, opens the fixture project of apps/vscode/scripts/lib/editor-fixture.mjs with the built plugin
// against the stub Piwi instance served from this process, on an Xvfb display this script starts; the keys and
// clicks the scenes need go through `xinput.py` (XTEST), and ImageMagick's `import` captures the screen. The images
// are rendered at 2× (`sun.java2d.uiScale`) and written at the window's width, 1440 px, to
// apps/docs/public/screenshots/jetbrains-<scene>.png.
//
//   npm run editor:build -w packages/editor && (cd apps/jetbrains && ./gradlew buildPlugin)
//   node scripts/take-screenshots.mjs [--out <dir>] [--scene <name>…] [--ide <WebStorm directory>] [--probe]
//
// `--probe` only starts the IDE on the project, waits, captures the screen as it stands and exits: the way to look
// at what the IDE shows before a scene drives it.
//
// The IDE must be activated: a WebStorm release asks for a licence and an EAP build for a JetBrains account before it
// shows the project, and neither can be answered from a script. The config directory this script writes holds no
// licence, so run it on a machine whose IDE is activated and pass that IDE's config directory with `--config <dir>`
// (its `idea.key` and settings are copied; the scenes' state is written beside them). The scenes have not yet been
// driven through an activated IDE: `--probe` is the verified part.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/** The WebStorm the Gradle build downloaded for `platformVersion`, unless `--ide` names one. */
function findIde() {
  if (option('--ide')) return path.resolve(option('--ide'));
  const caches = path.join(os.homedir(), '.gradle', 'caches');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (/^WebStorm-/.test(entry.name) && fs.existsSync(path.join(full, 'bin', 'webstorm.sh'))) found.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(caches, 0);
  if (!found.length)
    throw new Error('No WebStorm under ~/.gradle/caches: run `./gradlew buildPlugin` first, or pass --ide.');
  return found.sort().at(-1);
}

/** The built plugin, unpacked into a plugins directory of its own. */
function unpackPlugin(into) {
  const dist = path.join(pluginRoot, 'build', 'distributions');
  const zip = fs.existsSync(dist) ? fs.readdirSync(dist).find((f) => /^piwi-jetbrains-.*\.zip$/.test(f)) : undefined;
  if (!zip) throw new Error('The plugin is not built: run `./gradlew buildPlugin` first.');
  fs.mkdirSync(into, { recursive: true });
  execFileSync('unzip', ['-q', path.join(dist, zip), '-d', into]);
}

/** The project's IDE state: the page object open at the failing line, the Piwi tool window below the editor. */
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
  <component name="FileEditorManager">
    <leaf SIDE_TABS_SIZE_LIMIT_KEY="300">
      <file pinned="false" current-in-tab="false">
        <entry file="file://$PROJECT_DIR$/${SPEC_FILE}">
          <provider selected="true" editor-type-id="text-editor">
            <state relative-caret-position="0">
              <caret line="0" column="0" selection-start-line="0" selection-start-column="0" selection-end-line="0" selection-end-column="0" />
            </state>
          </provider>
        </entry>
      </file>
      <file pinned="false" current-in-tab="true">
        <entry file="file://$PROJECT_DIR$/${PAGE_OBJECT_FILE}">
          <provider selected="true" editor-type-id="text-editor">
            <state relative-caret-position="308">
              <caret line="${FAILING_LINE - 1}" column="4" selection-start-line="${FAILING_LINE - 1}" selection-start-column="4" selection-end-line="${FAILING_LINE - 1}" selection-end-column="4" />
            </state>
          </provider>
        </entry>
      </file>
    </leaf>
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
      <window_info id="Piwi" anchor="bottom" active="false" visible="true" weight="0.32" order="0" />
      <window_info id="Problems View" anchor="bottom" visible="false" order="1" />
    </layout>
  </component>
</project>
`,
  );
}

/** The IDE's own directories, under one temporary root: its settings, its caches and the built plugin. */
function writeIdeDirs(root, ide) {
  const dirs = {
    config: path.join(root, 'config'),
    system: path.join(root, 'system'),
    plugins: path.join(root, 'plugins'),
    log: path.join(root, 'log'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  if (configFrom) fs.cpSync(configFrom, dirs.config, { recursive: true });
  unpackPlugin(dirs.plugins);
  // No tips, no update checks, and no AI Assistant promotion in the frame.
  fs.writeFileSync(path.join(dirs.config, 'disabled_plugins.txt'), 'com.intellij.ml.llm\n');
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
  fs.writeFileSync(
    path.join(options, 'editor.xml'),
    `<application>
  <component name="EditorSettings">
    <option name="IS_WHITESPACES_SHOWN" value="false" />
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
async function shoot(name) {
  const raw = path.join(os.tmpdir(), `piwi-jetbrains-${name}-${process.pid}.png`);
  execFileSync('import', ['-display', DISPLAY, '-window', 'root', raw]);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `jetbrains-${name}.png`);
  await writeAtWidth(await cutWindow(raw), WINDOW.width, file);
  fs.rmSync(raw, { force: true });
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

/** Waits until the IDE's log says the project is open and the editor service runs, or `ms` passed. */
async function waitForIde(logDir, ms) {
  const log = path.join(logDir, 'idea.log');
  const start = Date.now();
  let seen = { project: false, lsp: false };
  while (Date.now() - start < ms) {
    if (fs.existsSync(log)) {
      const text = fs.readFileSync(log, 'utf-8');
      seen = {
        project: /Project opened|Loaded project|project opened/i.test(text),
        lsp: /LSP server|piwi-language-server|Piwi/i.test(text),
      };
      if (seen.project && seen.lsp) return seen;
    }
    await sleep(2000);
  }
  return seen;
}

const SCENES = {
  /** The page object at its failing line, the Piwi tool window below with the run's failures. */
  async failures() {
    await shoot('failures');
  },

  /** The quick fixes on the failing line, Alt+Enter. */
  async heal() {
    xinput('key', 'alt+Return');
    await sleep(2500);
    await shoot('heal');
    xinput('key', 'Escape');
    await sleep(500);
  },
};

async function main() {
  const ide = findIde();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-jetbrains-shots-')));
  const { workspace, commit } = writeWorkspace(root);
  writeIdeaState(workspace);
  const dirs = writeIdeDirs(root, ide);
  const { server, url } = await startStub(commit);
  const xvfb = spawn(
    'Xvfb',
    [DISPLAY, '-screen', '0', `${WINDOW.width * SCALE}x${WINDOW.height * SCALE}x24`, '-nolisten', 'tcp'],
    {
      stdio: 'ignore',
    },
  );
  await sleep(1500);
  const ideLog = fs.openSync(path.join(root, 'ide.out'), 'w');
  // JAVA_TOOL_OPTIONS would override the IDE's own options, and it says so in a notification.
  const { JAVA_TOOL_OPTIONS: _javaToolOptions, ...env } = process.env;
  const idea = spawn(path.join(ide, 'bin', 'webstorm.sh'), [workspace], {
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
  });
  try {
    const seen = await waitForIde(dirs.log, probe ? 90_000 : 180_000);
    console.log(
      `IDE: project ${seen.project ? 'open' : 'not seen'}, editor service ${seen.lsp ? 'started' : 'not seen'}`,
    );
    // Indexing and the first diagnostics take a while after the project opens.
    await sleep(probe ? 20_000 : 45_000);
    if (probe) {
      await shoot('probe');
      return;
    }
    const names = Object.keys(SCENES).filter((name) => only.length === 0 || only.includes(name));
    for (const name of names) await SCENES[name]();
  } finally {
    try {
      process.kill(-idea.pid, 'SIGTERM');
    } catch {}
    await sleep(3000);
    try {
      process.kill(-idea.pid, 'SIGKILL');
    } catch {}
    xvfb.kill('SIGTERM');
    server.close();
    fs.closeSync(ideLog);
    if (!args.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`kept ${root}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
