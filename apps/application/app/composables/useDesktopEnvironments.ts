/**
 * The environments the desktop app's pickers offer for a project's local runs (desktop shell only): the project's own
 * that are not archived (`useProjectEnvironments`) and, when its linked folder is also linked to a team project (Run
 * on my machine), that team project's, which the shell reads from the team instance with the target key each time
 * they are asked for (`desktop_team_environments`), never kept. When the instance cannot be reached, its environments
 * are not offered and `teamProblem` says why. `withTeam: false` reads the project's own only.
 *
 * What a run for an environment gets is the shell's to read when it starts; `readDesktopRunSettings` asks it the same
 * way, for the commands the window shows.
 */
import type { EnvironmentForRun } from '@piwitests/core/environments';
import type { RunVariable } from '@piwitests/core/run-variables';
import {
  DESKTOP_ENVIRONMENT_STORAGE_KEY,
  lastPickFor,
  pickOf,
  withLastPick,
  type DesktopEnvironmentChoice,
  type DesktopEnvironmentPick,
} from '#shared/desktop-environments';

/** The team project's environments as the shell answers them. */
interface ShellTeamEnvironments {
  instance: string | null;
  projectId: number | null;
  environments: Array<EnvironmentForRun & { aliases: string[]; appFromCheckout: boolean }>;
  problem: string | null;
}

/** What a run of the project for an environment gets, as the shell reads it when the run starts. */
export interface DesktopRunSettings {
  runVariables: RunVariable[];
  environment: EnvironmentForRun | null;
}

/**
 * The run variables and the environment a run of `projectId` for `pick` gets, as the shell reads them (its own
 * server, or the team instance for a team environment). Throws with the shell's words when they cannot be read or a
 * check fails: the run would not start either.
 */
export async function readDesktopRunSettings(
  projectId: string | number,
  pick: DesktopEnvironmentPick | null,
): Promise<DesktopRunSettings> {
  const core = tauriCore();
  if (!core) throw new Error('The desktop bridge is unavailable.');
  return await core.invoke<DesktopRunSettings>('desktop_environment_run_settings', {
    projectId: String(projectId),
    environment: pick,
  });
}

function readLastPicks(): unknown {
  try {
    const raw = localStorage.getItem(DESKTOP_ENVIRONMENT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The last environment picked for the linked folder `folder` on this machine; undefined when none was. */
export function lastDesktopEnvironmentPick(
  folder: string | null | undefined,
): DesktopEnvironmentPick | null | undefined {
  return lastPickFor(readLastPicks(), folder);
}

/** Keep `choice` as the last environment picked for the linked folder `folder`, on this machine. */
export function rememberDesktopEnvironmentPick(folder: string, choice: DesktopEnvironmentChoice | null) {
  try {
    localStorage.setItem(
      DESKTOP_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify(withLastPick(readLastPicks(), folder, pickOf(choice))),
    );
  } catch {
    // Unavailable storage: the next picker starts on its own default.
  }
}

export function useDesktopEnvironments(
  projectId: MaybeRefOrGetter<string | number | null | undefined>,
  options: { withTeam?: boolean } = {},
) {
  const withTeam = options.withTeam ?? true;
  const project = useProjectEnvironments(projectId);
  const team = ref<ShellTeamEnvironments | null>(null);
  const teamLoading = ref(false);
  let asked = 0;

  /** Reads the team project's environments again from the team instance, through the shell. */
  async function refreshTeam() {
    const id = toValue(projectId);
    const core = tauriCore();
    const ask = ++asked;
    if (!withTeam || id == null || !core) {
      team.value = null;
      return;
    }
    teamLoading.value = true;
    try {
      const answer = await core.invoke<ShellTeamEnvironments>('desktop_team_environments', { projectId: String(id) });
      if (ask === asked) team.value = answer;
    } catch (error) {
      if (ask === asked)
        team.value = { instance: null, projectId: null, environments: [], problem: errorMessage(error) };
    } finally {
      if (ask === asked) teamLoading.value = false;
    }
  }

  onMounted(() => {
    watch(
      () => toValue(projectId),
      () => void refreshTeam(),
      { immediate: true },
    );
  });

  const projectChoices = computed<DesktopEnvironmentChoice[]>(() =>
    project.active.value.map((environment) => ({
      id: environment.id,
      key: environment.key,
      name: environment.name,
      protected: environment.protected,
      requiredTags: environment.protected ? environment.requiredTags : [],
      envFile: environment.envFile,
      team: false,
      aliases: environment.aliases,
      appFromCheckout: environment.appFromCheckout,
    })),
  );

  const teamChoices = computed<DesktopEnvironmentChoice[]>(() =>
    (team.value?.environments ?? []).map((environment) => ({ ...environment, team: true })),
  );

  /** Every environment offered: the project's, then the team project's. */
  const choices = computed(() => [...projectChoices.value, ...teamChoices.value]);

  /** The team instance's host, when the folder is linked to a team project. */
  const teamHost = computed(() => (team.value?.instance ? teamInstanceHost(team.value.instance) : null));

  /** Why the team project's environments cannot be picked now; null when they can or there is no team project. */
  const teamProblem = computed(() => team.value?.problem ?? null);

  /** Whether the lists offered are read: the project's, and the team project's when there is one to read. */
  const loaded = computed(() => project.loaded.value && !teamLoading.value);

  return {
    choices,
    projectChoices,
    teamChoices,
    teamHost,
    teamProblem,
    teamLoading,
    loaded,
    refreshTeam,
  };
}
