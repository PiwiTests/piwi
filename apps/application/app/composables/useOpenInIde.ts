/**
 * "Open in IDE" — turns a repo-relative source path into a launch into the
 * user's local editor (the Piwi JetBrains plugin, VS Code family via
 * `vscode://` or, without a workspace root, the Piwi extension's
 * `vscode://piwitests.piwi/open` link, JetBrains via the `jetbrains://`
 * navigate URL, or the JetBrains built-in local server / IDE Remote Control
 * plugin).
 *
 * Preferences (which method, the local workspace root that maps a repo-relative
 * path to an absolute one, the VS Code flavor, the JetBrains product/port) are a
 * per-browser client setting kept in `localStorage` — NOT server-backed and NOT
 * part of the DB/env `SETTINGS_PAGES` registry (the source lives on the visitor's
 * machine, so the mapping is inherently per-device). Configure them in
 * `OpenInIdeSettingsModal`.
 *
 * Only the Piwi JetBrains plugin confirms the file opened: it answers JSON the
 * page can read, and finds the file in the IDE's open projects itself, so it
 * needs no setting. Every JetBrains method asks it first. The URL schemes are
 * fire-and-forget, and the IDE Remote Control endpoint can only be reached, not
 * read, so neither can report success.
 */
import {
  buildJetbrainsHttpUrl,
  buildJetbrainsNavigateUrl,
  buildPiwiPluginOpenUrl,
  buildVscodeExtensionUrl,
  buildVscodeUrl,
  jetbrainsPorts,
  joinWorkspacePath,
  pickPiwiPluginAnswer,
  VSCODE_CLI_COMMANDS,
  type IdeFamily,
  type PiwiPluginAnswer,
  type VscodeScheme,
} from '~/utils/ide-links';

export type IdeMethod = 'auto' | 'vscode' | 'jetbrains-url' | 'jetbrains-http';

export interface IdePrefs {
  method: IdeMethod;
  vscodeScheme: VscodeScheme;
  jetbrainsProduct: string;
  jetbrainsPort: number;
  /** Send a content-root-relative path to the local server instead of an absolute one. */
  jetbrainsHttpUsesRelativePath: boolean;
  /**
   * The Piwi extension is installed in VS Code: with no workspace root and no
   * JetBrains project name, Auto opens the file through it.
   */
  vscodeExtension: boolean;
  /** Global local checkout root; '' when unset. */
  defaultRoot: string;
  /** Piwi project id → absolute root override (monorepo / multiple checkouts). */
  projectRoots: Record<string, string>;
  /** Piwi project id → IDE project name override (for the jetbrains:// URL). */
  jetbrainsProjectNames: Record<string, string>;
}

export interface OpenTarget {
  filePath: string;
  line?: number | null;
  column?: number | null;
  /** Piwi project id — selects the per-project root/name override. */
  projectKey?: string | number | null;
  /** Piwi project name — default IDE project name for the jetbrains:// URL. */
  projectName?: string | null;
  /** Per-call method override from the chooser; omit to use the stored default. */
  method?: IdeMethod;
}

export interface IdeSettingsContext {
  projectKey?: string | null;
  projectName?: string | null;
}

const STORAGE_KEY = 'piwi-ide-prefs';

const DEFAULT_PREFS: IdePrefs = {
  method: 'auto',
  vscodeScheme: 'vscode',
  jetbrainsProduct: 'idea',
  jetbrainsPort: 63342,
  jetbrainsHttpUsesRelativePath: false,
  vscodeExtension: true,
  defaultRoot: '',
  projectRoots: {},
  jetbrainsProjectNames: {},
};

export const VSCODE_SCHEME_LABELS: Record<VscodeScheme, string> = {
  vscode: 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  vscodium: 'VSCodium',
  cursor: 'Cursor',
};

/** What asking the Piwi JetBrains plugin to open a file came to. */
type PiwiPluginResult =
  | { status: 'opened'; answer: PiwiPluginAnswer }
  /** An IDE with the plugin answered, but none of its open projects holds the file. */
  | { status: 'not-found'; answer: PiwiPluginAnswer }
  /** No IDE with the plugin is running (or the page may not reach it). */
  | { status: 'unreachable' };

/**
 * The port the Piwi JetBrains plugin last opened a file on, asked alone first so
 * a click does not reach every port of the range. Kept for the page's lifetime.
 */
let lastPiwiPluginPort: number | null = null;

export const IDE_METHOD_LABELS: Record<IdeMethod, string> = {
  auto: 'Auto (try all)',
  vscode: 'VS Code',
  'jetbrains-url': 'JetBrains (URL)',
  'jetbrains-http': 'JetBrains (local server)',
};

/** Common JetBrains product tags for the `jetbrains://<product>/…` URL. */
export const JETBRAINS_PRODUCTS = [
  'idea',
  'webstorm',
  'pycharm',
  'phpstorm',
  'goland',
  'rubymine',
  'clion',
  'rider',
  'rustrover',
] as const;

export function useOpenInIde() {
  const prefs = useLocalStorage<IdePrefs>(STORAGE_KEY, DEFAULT_PREFS, { mergeDefaults: true });
  const toast = useToast();

  // A single global settings modal, toggled via shared state (useState keys are
  // shared across every component that calls this composable).
  const settingsOpen = useState('piwi-ide-settings-open', () => false);
  const settingsContext = useState<IdeSettingsContext>('piwi-ide-settings-context', () => ({}));

  function projectKeyOf(projectKey?: string | number | null): string | null {
    if (projectKey == null || projectKey === '') return null;
    return String(projectKey);
  }

  function openSettings(ctx: IdeSettingsContext = {}) {
    settingsContext.value = { projectKey: ctx.projectKey ?? null, projectName: ctx.projectName ?? null };
    settingsOpen.value = true;
  }

  function resolveRoot(projectKey?: string | number | null): string {
    const k = projectKeyOf(projectKey);
    const perProject = k ? prefs.value.projectRoots[k] : undefined;
    return (perProject || prefs.value.defaultRoot || '').trim();
  }

  function resolveJbProjectName(projectKey?: string | number | null, projectName?: string | null): string {
    const k = projectKeyOf(projectKey);
    const perProject = k ? prefs.value.jetbrainsProjectNames[k] : undefined;
    return (perProject || projectName || '').trim();
  }

  /** Absolute path for a repo-relative file, or null when no root is configured. */
  function resolveAbsPath(filePath: string, projectKey?: string | number | null): string | null {
    const root = resolveRoot(projectKey);
    return root ? joinWorkspacePath(root, filePath) : null;
  }

  /**
   * Which command-line launchers the desktop shell should try for a method, in
   * order. VS Code flavors map to their `code`/`cursor`/… commands; JetBrains
   * uses the product tag, which is also the launcher name Toolbox generates
   * (`idea`, `rider`, `webstorm`, …). Auto tries JetBrains first when a
   * JetBrains IDE is running, VS Code first otherwise: the shell finds a
   * launcher for every IDE installed, not only the one in use.
   */
  function desktopAttempts(
    method: IdeMethod,
    jetbrainsFirst: boolean,
  ): Array<{ family: IdeFamily; command: string; label: string }> {
    const vscode = {
      family: 'vscode' as const,
      command: VSCODE_CLI_COMMANDS[prefs.value.vscodeScheme],
      label: VSCODE_SCHEME_LABELS[prefs.value.vscodeScheme],
    };
    const product = prefs.value.jetbrainsProduct.trim();
    const jetbrains = product ? [{ family: 'jetbrains' as const, command: product, label: 'JetBrains' }] : [];
    if (method === 'vscode') return [vscode];
    if (method === 'jetbrains-url' || method === 'jetbrains-http') return jetbrains;
    return jetbrainsFirst ? [...jetbrains, vscode] : [vscode, ...jetbrains];
  }

  const isConfigured = computed(
    () =>
      !!prefs.value.defaultRoot?.trim() ||
      Object.keys(prefs.value.projectRoots).length > 0 ||
      Object.keys(prefs.value.jetbrainsProjectNames).length > 0,
  );

  /**
   * Hand off a custom-scheme URL to the OS without navigating the top frame (a
   * hidden iframe avoids `beforeunload` and losing SPA state). Safari can block
   * custom schemes inside iframes, so fall back to a transient anchor click.
   */
  function launchScheme(url: string) {
    if (!import.meta.client) return;
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = url;
      document.body.appendChild(iframe);
      setTimeout(() => iframe.remove(), 1000);
    } catch {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => anchor.remove(), 1000);
    }
  }

  /**
   * Probe the JetBrains local server. With `no-cors` we get an opaque response we
   * can't read, so a resolved promise means "reachable" (best available signal),
   * a rejection means refused/blocked (incl. HTTPS mixed-content).
   */
  async function probeJetbrainsHttp(path: string, line?: number | null, column?: number | null): Promise<boolean> {
    if (!import.meta.client) return false;
    const url = buildJetbrainsHttpUrl({ port: prefs.value.jetbrainsPort, path, line, column });
    try {
      await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(1200) });
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a JetBrains IDE's built-in server answers on the configured port (a refused port rejects at once). */
  async function jetbrainsServerUp(): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${prefs.value.jetbrainsPort}/`, {
        mode: 'no-cors',
        signal: AbortSignal.timeout(800),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** One request to the Piwi JetBrains plugin; null when nothing, or not the plugin, answered on the port. */
  async function askPiwiPlugin(
    port: number,
    o: Omit<Parameters<typeof buildPiwiPluginOpenUrl>[0], 'port'>,
  ): Promise<PiwiPluginAnswer | null> {
    try {
      const res = await fetch(buildPiwiPluginOpenUrl({ port, ...o }), { signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as PiwiPluginAnswer | null;
      return typeof body?.found === 'boolean' ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Open the file through the Piwi JetBrains plugin: ask the running IDEs which
   * one holds it (the port that worked last alone first, then every port of the
   * range at once, a refused port answering at once), then have that one open it.
   */
  async function openViaPiwiPlugin(o: {
    path: string;
    root: string | null;
    line: number | null;
    column: number | null;
    project: string | null;
  }): Promise<PiwiPluginResult> {
    const check = (ports: number[]) =>
      Promise.all(ports.map(async (port) => ({ port, answer: await askPiwiPlugin(port, { ...o, check: true }) })));
    let answers = lastPiwiPluginPort != null ? await check([lastPiwiPluginPort]) : [];
    if (!answers.some((a) => a.answer?.found)) {
      const others = jetbrainsPorts(prefs.value.jetbrainsPort).filter((p) => p !== lastPiwiPluginPort);
      answers = [...answers, ...(await check(others))];
    }
    const best = pickPiwiPluginAnswer(answers, prefs.value.jetbrainsProduct);
    if (best) {
      const opened = await askPiwiPlugin(best.port, o);
      if (opened?.found) {
        lastPiwiPluginPort = best.port;
        return { status: 'opened', answer: opened };
      }
    }
    const reached = answers.find((a) => a.answer)?.answer;
    return reached ? { status: 'not-found', answer: reached } : { status: 'unreachable' };
  }

  async function openInIde(target: OpenTarget) {
    if (!import.meta.client) return;

    const method = target.method ?? prefs.value.method;
    const rel = target.filePath;
    const line = target.line ?? null;
    const column = target.column ?? null;
    // Desktop shell: a project's linked folder stands in for an unconfigured
    // workspace root, so IDE links work with zero setup.
    let root = resolveRoot(target.projectKey);
    if (!root) {
      const linked = await getDesktopProjectLink(target.projectKey);
      if (linked?.exists) root = linked.path;
    }
    const jbName = resolveJbProjectName(target.projectKey, target.projectName);
    const ctx: IdeSettingsContext = {
      projectKey: projectKeyOf(target.projectKey),
      projectName: target.projectName ?? null,
    };
    const configureAction = { label: 'Configure', color: 'info' as const, onClick: () => openSettings(ctx) };

    // The Piwi extension finds the run's path in the VS Code window focused
    // last; like any URL scheme, it cannot report whether the file opened.
    const openVscodeExtension = () => {
      const editor = VSCODE_SCHEME_LABELS[prefs.value.vscodeScheme];
      launchScheme(buildVscodeExtensionUrl({ scheme: prefs.value.vscodeScheme, path: rel, line, column }));
      toast.add({
        title: `Asked the Piwi extension in ${editor}`,
        description: `It opens the file in the ${editor} window focused last when that window holds it. If nothing opens, install the Piwi extension in ${editor}, or set a workspace root.`,
        color: 'neutral',
        icon: 'i-lucide-external-link',
        actions: [configureAction],
      });
    };

    const openVscode = (): boolean => {
      if (!root && prefs.value.vscodeExtension) {
        openVscodeExtension();
        return true;
      }
      if (!root) {
        toast.add({
          title: 'Set a workspace root',
          description: 'VS Code needs the local folder that contains this file, or the Piwi extension.',
          color: 'info',
          icon: 'i-lucide-folder-cog',
          actions: [configureAction],
        });
        return false;
      }
      launchScheme(
        buildVscodeUrl({ scheme: prefs.value.vscodeScheme, absPath: joinWorkspacePath(root, rel), line, column }),
      );
      toast.add({
        title: `Opening ${VSCODE_SCHEME_LABELS[prefs.value.vscodeScheme]}…`,
        description: 'If nothing opens, the editor may not be installed or the workspace root is wrong.',
        color: 'neutral',
        icon: 'i-lucide-external-link',
      });
      return true;
    };

    const openJetbrainsUrl = (): boolean => {
      if (!jbName) {
        toast.add({
          title: 'Set a JetBrains project name',
          description: 'The jetbrains:// link needs the open IDE project name.',
          color: 'info',
          icon: 'i-lucide-folder-cog',
          actions: [configureAction],
        });
        return false;
      }
      launchScheme(
        buildJetbrainsNavigateUrl({
          product: prefs.value.jetbrainsProduct,
          projectName: jbName,
          relPath: rel,
          line,
          column,
        }),
      );
      toast.add({
        title: 'Opening JetBrains…',
        description: 'If nothing opens, JetBrains Toolbox may not be installed or the project is not open.',
        color: 'neutral',
        icon: 'i-lucide-external-link',
      });
      return true;
    };

    // IDE Remote Control's `/api/file`: the page can reach it but not read its
    // answer, so "reachable" is all it can report, never that the file opened.
    const openJetbrainsHttp = async (): Promise<boolean> => {
      const path = prefs.value.jetbrainsHttpUsesRelativePath ? rel : root ? joinWorkspacePath(root, rel) : rel;
      const ok = await probeJetbrainsHttp(path, line, column);
      toast.add(ok ? sentToJetbrains : jetbrainsUnreachable);
      return ok;
    };
    const sentToJetbrains = {
      title: 'Sent to JetBrains',
      description:
        'The IDE cannot confirm the file opened. If nothing opened, install the Piwi plugin in the IDE: it finds the file in your open projects and says so.',
      color: 'neutral' as const,
      icon: 'i-lucide-external-link',
    };
    const jetbrainsUnreachable = {
      title: 'JetBrains not reachable',
      description: `No JetBrains IDE with the Piwi plugin is running, and nothing responded on localhost:${prefs.value.jetbrainsPort}. Start the IDE with the Piwi plugin, or with IDE Remote Control and "Allow unsigned requests".`,
      color: 'error' as const,
      icon: 'i-lucide-plug-zap',
    };
    const notFoundInJetbrains = (answer: PiwiPluginAnswer) => {
      const ide = answer.ide ?? 'JetBrains';
      toast.add({
        title: `Not found in ${ide}`,
        description: answer.projects?.length
          ? `None of the projects open in ${ide} (${answer.projects.join(', ')}) holds ${rel}. Open the project that contains it.`
          : `No project is open in ${ide}. Open the project that contains ${rel}.`,
        color: 'warning',
        icon: 'i-lucide-file-question',
        actions: [configureAction],
      });
    };

    // 1. The Piwi JetBrains plugin, for every method but VS Code: it finds the
    //    file in the IDE's open projects with no setting (the workspace root, when
    //    set, is only a hint), opens it at the line, and says whether it did.
    let plugin: PiwiPluginResult = { status: 'unreachable' };
    if (method !== 'vscode') {
      plugin = await openViaPiwiPlugin({
        path: rel,
        root: root || null,
        line,
        column,
        project: target.projectName ?? null,
      });
      if (plugin.status === 'opened') {
        toast.add({
          title: `Opened in ${plugin.answer.ide ?? 'JetBrains'}`,
          description: plugin.answer.project,
          color: 'success',
          icon: 'i-lucide-check',
        });
        return;
      }
    }

    // 2. Desktop shell: spawn the IDE's command-line launcher. It opens the file
    //    at the line and reports whether it actually started, where the URL
    //    schemes below are fire-and-forget. On a machine with no matching
    //    launcher this falls through to those schemes unchanged.
    if (tauriCore() && root) {
      const abs = joinWorkspacePath(root, rel);
      const jetbrainsFirst = plugin.status === 'not-found' || (method === 'auto' && (await jetbrainsServerUp()));
      for (const attempt of desktopAttempts(method, jetbrainsFirst)) {
        const res = await openFileInDesktopIde({
          family: attempt.family,
          command: attempt.command,
          absPath: abs,
          line,
          column,
        });
        if (res.ok) {
          toast.add({ title: `Opened in ${attempt.label}`, color: 'success', icon: 'i-lucide-check' });
          return;
        }
        if (res.reason) {
          // A real error (a missing file, a bad path) — a URL scheme won't help.
          toast.add({
            title: 'Could not open in IDE',
            description: res.reason,
            color: 'error',
            icon: 'i-lucide-triangle-alert',
            actions: [configureAction],
          });
          return;
        }
        // Otherwise no such launcher is installed — try the next / fall through.
      }
    }

    if (method === 'vscode') {
      openVscode();
      return;
    }
    if (method === 'jetbrains-url') {
      openJetbrainsUrl();
      return;
    }
    if (method === 'jetbrains-http') {
      // The plugin's answer already says the IDE holds no such file; `/api/file` would not find it either.
      if (plugin.status === 'not-found') notFoundInJetbrains(plugin.answer);
      else await openJetbrainsHttp();
      return;
    }

    // Auto. A JetBrains IDE with the Piwi plugin is running but holds no such
    // file: say so, rather than launch an editor that is likely not the one in use.
    if (plugin.status === 'not-found') {
      notFoundInJetbrains(plugin.answer);
      return;
    }
    // Then IDE Remote Control (a refused localhost connection rejects near-
    // instantly, so this rarely waits the full timeout), then exactly one
    // URL-scheme launch. Neither can report success.
    const canProbeHttp = prefs.value.jetbrainsHttpUsesRelativePath || !!root;
    if (canProbeHttp) {
      const path = prefs.value.jetbrainsHttpUsesRelativePath ? rel : joinWorkspacePath(root, rel);
      if (await probeJetbrainsHttp(path, line, column)) {
        toast.add(sentToJetbrains);
        return;
      }
    }
    if (root) {
      openVscode();
      return;
    }
    if (jbName) {
      openJetbrainsUrl();
      return;
    }
    if (prefs.value.vscodeExtension) {
      openVscodeExtension();
      return;
    }
    toast.add({
      title: 'Set up "Open in IDE"',
      description:
        'Install the Piwi plugin in your JetBrains IDE and connect its project to this instance, install the Piwi extension in VS Code and tick it here, or add your local workspace folder (for VS Code) or a JetBrains project name, to open files from here.',
      color: 'info',
      icon: 'i-lucide-folder-cog',
      actions: [configureAction],
    });
  }

  return {
    prefs,
    isConfigured,
    openInIde,
    openInVscode: (t: Omit<OpenTarget, 'method'>) => openInIde({ ...t, method: 'vscode' }),
    openViaJetbrainsUrl: (t: Omit<OpenTarget, 'method'>) => openInIde({ ...t, method: 'jetbrains-url' }),
    openViaJetbrainsHttp: (t: Omit<OpenTarget, 'method'>) => openInIde({ ...t, method: 'jetbrains-http' }),
    resolveRoot,
    resolveJbProjectName,
    resolveAbsPath,
    settingsOpen,
    settingsContext,
    openSettings,
  };
}
