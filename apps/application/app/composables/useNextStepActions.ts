/**
 * The one place both failure pages turn a next-step action id into the real
 * behaviour. `NextStepLine` stays presentation-only and emits an id; the page
 * hands this composable the page-specific targets (the change the row shows,
 * its locator panel, its scroll anchors, how it sets the cluster status,
 * quarantines, re-runs) as callbacks, and the composable owns the shared
 * plumbing — the change's apply command, locator, download and open-in-IDE,
 * the recipe copy, the AI-prompt copy, the Flake Lab command and its CI
 * dispatch, the navigation (to an execution, a run and its tab) — so the
 * execution page and the cluster page never duplicate the switch.
 */
import { reproScript, type ReproRecipe } from '#shared/reproduce';
import type { NextStepChange } from '~/utils/next-step-change';

/** The locator healing panel's exposed actions (see `LocatorHealingPanel`). */
export interface LocatorPanelActions {
  openPicker: () => void;
  expandAlternatives: () => void;
}

/** The toolbox sections a next-step action opens. */
type ToolboxSectionKey = 'diagnosis' | 'reproduce' | 'locator-fix';

export interface NextStepActionHandlers {
  /** The cluster whose fix plan / status the code-change actions target. */
  clusterId: () => number | null | undefined;
  /**
   * The change the Next row shows (`buildNextStepChange`): the copy, download
   * and open-in-IDE actions read it, so they copy what the row shows.
   */
  change: () => NextStepChange | null;
  /** Base filename for the downloaded patch; defaults to one naming the cluster. */
  patchBaseName?: () => string;
  /** The project the open-in-IDE link resolves against. */
  ideProject?: () => { id?: number | string | null; name?: string | null } | null | undefined;
  /** The locator healing panel exposing the pick and alternatives actions. */
  locatorPanel: () => LocatorPanelActions | null | undefined;
  /** The local reproduction recipe backing copy-recipe. */
  reproRecipe: () => ReproRecipe | null | undefined;
  /** The endpoint the AI prompt is copied from (`?format=prompt` is appended). */
  diagnosisContextEndpoint: () => string;
  /**
   * Open a toolbox section and scroll it into view, at the element whose
   * `data-shot` is `anchor` when the section holds one; resolves once its body
   * is mounted. The `pick-from-snapshot`, `all-alternatives`, `read-diagnosis`,
   * `full-patch`, `diagnose` and `reproduce` actions use it.
   */
  scrollToSection: (key: ToolboxSectionKey, anchor?: string) => void | Promise<void>;
  /** Select the Attempts evidence tab. */
  selectAttemptsTab: () => void;
  /** Set the cluster's triage status. */
  setClusterStatus: (status: 'open' | 'resolved') => void | Promise<void>;
  /** Quarantine the (selected) test. */
  quarantine: (payload?: Record<string, unknown>) => void | Promise<void>;
  /** Re-run the cluster's tests in CI. */
  rerunInCi: () => void | Promise<void>;
  /** Open the execution the payload names; defaults to navigating to its page. */
  openExecution?: (executionId: number) => void | Promise<void>;
  /** "What changed" — the cluster page scrolls, the execution page navigates. */
  whatChanged: () => void | Promise<void>;
  /** "Re-diagnose" — scroll to the diagnosis and trigger it (page-specific). */
  reDiagnose: () => void | Promise<void>;
}

/** The file (and line) a unified diff targets — for the open-in-IDE action. */
function patchTargetFile(patch: string): { filePath: string; line: number | null } | null {
  const file = patch.match(/^\+\+\+ b\/(.+)$/m) ?? patch.match(/^--- a\/(.+)$/m);
  if (!file?.[1]) return null;
  const hunk = patch.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  return { filePath: file[1].trim(), line: hunk ? Number(hunk[1]) : null };
}

/** Dispatch a test's Flake Lab experiment to the project's Flake Lab CI target, and say how it went. */
async function runFlakeLabInCi(testCaseId: number, kind: string) {
  const toast = useToast();
  try {
    const res = await $fetch<{ ok: boolean; message?: string; dispatch?: { url: string } }>(
      `/api/test-cases/${testCaseId}/flake-lab-ci`,
      { method: 'POST', body: { kind } },
    );
    if (res.ok && res.dispatch) {
      toast.add({
        title: 'Flake Lab dispatched to CI',
        description: 'The experiment shows on the Flakiness tab when it finishes.',
        color: 'success',
        actions: [{ label: 'Watch it', to: res.dispatch.url, target: '_blank', color: 'neutral', variant: 'outline' }],
      });
    } else {
      toast.add({ title: 'Flake Lab not started', description: res.message ?? 'Not available.', color: 'warning' });
    }
  } catch (e: unknown) {
    const message = (e as { data?: { message?: string } })?.data?.message ?? 'Dispatch failed.';
    toast.add({ title: 'Flake Lab dispatch failed', description: message, color: 'error' });
  }
}

export function useNextStepActions(handlers: NextStepActionHandlers) {
  const { copyGitApply, downloadPatch } = usePatchActions();
  const { copyPrompt } = useCopyAiPrompt();
  const { copy: copyPlain } = useCopy();
  const { openInIde } = useOpenInIde();
  const toast = useToast();

  /**
   * Run an action on the locator healing panel. A folded section renders no body,
   * so the Locator fix section opens and scrolls into view first; with no panel
   * on the page, an error toast says so.
   */
  async function onLocatorPanel(act: (panel: LocatorPanelActions) => void) {
    await handlers.scrollToSection('locator-fix');
    const panel = handlers.locatorPanel();
    if (panel) act(panel);
    else
      toast.add({
        title: 'Locator fix not available',
        description: 'This page has no Locator fix section to act on.',
        color: 'error',
      });
  }

  /** The change the row shows, or an error toast when it has not loaded. */
  function loadedChange(): NextStepChange | null {
    const change = handlers.change();
    if (!change)
      toast.add({
        title: 'The change is not loaded yet',
        description: 'Reload the page, or take it from the section below.',
        color: 'error',
      });
    return change;
  }

  async function handle(action: string, payload?: Record<string, unknown>) {
    switch (action) {
      case 'open-execution': {
        const id = payload?.executionId;
        if (typeof id !== 'number') break;
        if (handlers.openExecution) await handlers.openExecution(id);
        else await navigateTo(`/test-run-cases/${id}`);
        break;
      }
      case 'open-run': {
        const runId = payload?.runId;
        if (typeof runId !== 'number') break;
        const tab = typeof payload?.tab === 'string' ? payload.tab : undefined;
        await navigateTo({ path: `/test-runs/${runId}`, query: tab ? { tab } : {} });
        break;
      }
      case 'mark-resolved':
        await handlers.setClusterStatus('resolved');
        break;
      case 'reopen':
        await handlers.setClusterStatus('open');
        break;
      case 'copy-locator': {
        const locator = loadedChange()?.recommendedLocator;
        if (locator) copyPlain(locator, { toast: 'Locator copied' });
        break;
      }
      case 'pick-from-snapshot':
        await onLocatorPanel((panel) => panel.openPicker());
        break;
      case 'all-alternatives':
        await onLocatorPanel((panel) => panel.expandAlternatives());
        break;
      case 'copy-git-apply': {
        const patch = loadedChange()?.copyText;
        if (patch) copyGitApply(patch);
        break;
      }
      case 'download-patch': {
        const patch = loadedChange()?.copyText;
        const clusterId = handlers.clusterId();
        const fallback = clusterId != null ? `piwi-fix-cluster-${clusterId}` : 'piwi-fix';
        if (patch) downloadPatch(patch, handlers.patchBaseName?.() ?? fallback);
        break;
      }
      case 'full-patch':
        await handlers.scrollToSection('diagnosis', 'diagnosis-patch');
        break;
      case 'open-in-ide': {
        const patch = loadedChange()?.copyText;
        const target = patch ? patchTargetFile(patch) : null;
        const project = handlers.ideProject?.();
        if (target)
          openInIde({
            filePath: target.filePath,
            line: target.line,
            projectKey: project?.id ?? undefined,
            projectName: project?.name ?? undefined,
          });
        break;
      }
      case 'read-diagnosis':
      case 'diagnose':
        await handlers.scrollToSection('diagnosis');
        break;
      case 'reproduce':
        await handlers.scrollToSection('reproduce');
        break;
      case 'attempts-tab':
        handlers.selectAttemptsTab();
        break;
      case 'quarantine':
        await handlers.quarantine(payload);
        break;
      case 'rerun-in-ci':
        await handlers.rerunInCi();
        break;
      case 'copy-recipe': {
        const recipe = handlers.reproRecipe();
        if (recipe) copyPlain(reproScript(recipe, 'bash'), { toast: 'Recipe copied' });
        break;
      }
      case 'copy-ai-prompt':
        await copyPrompt(handlers.diagnosisContextEndpoint());
        break;
      case 'copy-flake-command':
        if (typeof payload?.command === 'string') copyPlain(payload.command, { toast: 'Lab command copied' });
        break;
      case 'flake-lab-ci':
        if (typeof payload?.testCaseId === 'number') await runFlakeLabInCi(payload.testCaseId, String(payload.kind));
        break;
      case 'flakiness-tab': {
        if (typeof payload?.testCaseId !== 'number') break;
        const suspect = typeof payload.suspect === 'string' ? payload.suspect : undefined;
        await navigateTo({ path: `/test-cases/${payload.testCaseId}`, query: { tab: 'flakiness', suspect } });
        break;
      }
      case 'configure-ai':
        await navigateTo('/settings/ai');
        break;
      case 'what-changed':
        await handlers.whatChanged();
        break;
      case 're-diagnose':
        await handlers.reDiagnose();
        break;
    }
  }

  return { handle };
}
