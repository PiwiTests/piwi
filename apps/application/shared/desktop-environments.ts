/**
 * The environments the desktop app's pickers offer for a run the shell starts: the desktop project's own and, for a
 * folder also linked to a team project (Run on my machine), that team project's, read from the team instance by the
 * shell. The window names the one picked by its id, whether it is the team project's (with the instance and the team
 * project it read it from), and the key of a protected one the person confirmed this run against
 * (`DesktopEnvironmentPick`); the shell reads the run variables and the environment itself, refuses a protected one
 * the pick does not confirm by its current key, and applies them (`apps/desktop/src-tauri/src/environments.rs`).
 *
 * Which one a picker starts on, per path: a re-run and Reproduce the environment of the run its tests come from,
 * unless protected, and the team project's of the same key when the desktop project's is one its runs discovered with
 * no run variables; Run with options and a bug report's reproduction the last one picked for the folder, kept on the
 * machine; Bisect one built from the checkout; Flake Lab the one the test's runs carry most, unless protected. A
 * protected environment is never where a picker starts, and only a run of tests and Reproduce offer one: Bisect, a bug
 * report's reproduction and Flake Lab never run against one. A protected run is limited to the tests carrying one of
 * its required tags, beside the setup and teardown projects they depend on, which Playwright runs whole.
 */
import { resolveEnvironment, type EnvironmentForRun } from '@piwitests/core/environments';

/** The environment a run is for, as the window names it to the shell. */
export interface DesktopEnvironmentPick {
  id: number;
  /** One of the team project's environments, rather than the desktop project's. */
  team: boolean;
  /** For a team environment, the instance and the team project the window read it from; else null. */
  instance: string | null;
  teamProject: number | null;
  /** The key of a protected environment the person confirmed this run against; else null. */
  confirmed: string | null;
}

/** An environment a picker offers. */
export interface DesktopEnvironmentChoice extends EnvironmentForRun {
  team: boolean;
  /** For a team environment, the instance and the team project it was read from; else null. */
  teamInstance: string | null;
  teamProjectId: number | null;
  /** The other labels its runs report, `*` patterns included. */
  aliases: string[];
  /** The application under test is built from the run's checkout; else it is deployed. */
  appFromCheckout: boolean;
  /** Created by a run's label, until a manager saves it. */
  discovered: boolean;
  /** How many run variables the environment sets itself. */
  ownVariables: number;
}

/** What a picker is for: each path starts on its own environment and says what applies to it. */
export type DesktopEnvironmentPurpose = 'run' | 'repro' | 'reproduce' | 'bisect' | 'flake';

/** Where the window keeps the last environment picked for each linked folder. */
export const DESKTOP_ENVIRONMENT_STORAGE_KEY = 'piwi:desktop-local-run-environments';

/** An environment as the window keeps it for a folder: its id, and whether it is the team project's. */
export interface DesktopEnvironmentRef {
  id: number;
  team: boolean;
}

/** The last environment picked for each linked folder, by path; `null` is None. */
export type DesktopLastPicks = Record<string, DesktopEnvironmentRef | null>;

/**
 * What the window names to the shell for a run for `choice`: `confirmedKey` is the key the person confirmed a protected
 * environment by for this run, sent only for a protected one; the shell runs a protected environment only when it is
 * its key now.
 */
export function pickOf(
  choice:
    | Pick<DesktopEnvironmentChoice, 'id' | 'team' | 'protected' | 'teamInstance' | 'teamProjectId'>
    | null
    | undefined,
  confirmedKey: string | null = null,
): DesktopEnvironmentPick | null {
  if (!choice) return null;
  return {
    id: choice.id,
    team: choice.team,
    instance: choice.team ? choice.teamInstance : null,
    teamProject: choice.team ? choice.teamProjectId : null,
    confirmed: choice.protected ? confirmedKey : null,
  };
}

export function samePick(
  a: DesktopEnvironmentRef | null | undefined,
  b: DesktopEnvironmentRef | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.team === b.team;
}

export function choiceOf(
  choices: readonly DesktopEnvironmentChoice[],
  pick: DesktopEnvironmentRef | null | undefined,
): DesktopEnvironmentChoice | null {
  return pick ? (choices.find((choice) => samePick(choice, pick)) ?? null) : null;
}

/** Whether a path offers a protected environment: a run of tests and Reproduce, never Bisect, a bug report or Flake Lab. */
export function offersProtected(purpose: DesktopEnvironmentPurpose): boolean {
  return purpose === 'run' || purpose === 'reproduce';
}

/** The choice unless it is protected: a protected environment is never where a picker starts. */
export function unlessProtected(choice: DesktopEnvironmentChoice | null | undefined): DesktopEnvironmentChoice | null {
  return choice && !choice.protected ? choice : null;
}

/**
 * The desktop project's environment `id`, unless protected: a re-run's and Reproduce's start. When the runs of a team
 * environment discovered it (a desktop environment with no run variables of its own) and the team project has an
 * environment of the same key, the team one: its run variables are the ones the run had.
 */
export function runEnvironmentChoice(
  choices: readonly DesktopEnvironmentChoice[],
  id: number | null | undefined,
): DesktopEnvironmentChoice | null {
  if (id == null) return null;
  const own = choiceOf(choices, { id, team: false });
  if (own?.discovered && own.ownVariables === 0) {
    const key = own.key.toLowerCase();
    const team = choices.find((choice) => choice.team && choice.key.toLowerCase() === key);
    if (team) return unlessProtected(team);
  }
  return unlessProtected(own);
}

/** The first environment built from the checkout, the desktop project's before the team's: Bisect's start. */
export function builtFromCheckoutChoice(choices: readonly DesktopEnvironmentChoice[]): DesktopEnvironmentChoice | null {
  const built = choices.filter((choice) => choice.appFromCheckout && !choice.protected);
  return built.find((choice) => !choice.team) ?? built[0] ?? null;
}

/**
 * The desktop project's environment the most of `environmentIds` name (the environments of a test's runs), the first
 * in the list's order on a tie, unless protected: Flake Lab's start.
 */
export function mostCarriedChoice(
  choices: readonly DesktopEnvironmentChoice[],
  environmentIds: readonly (number | null)[],
): DesktopEnvironmentChoice | null {
  const counts = new Map<number, number>();
  for (const id of environmentIds) if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best: number | null = null;
  for (const [id, count] of counts) if (best == null || count > counts.get(best)!) best = id;
  return runEnvironmentChoice(choices, best);
}

/** The last environment picked for `folder`, as the storage keeps it; undefined when none was picked there. */
export function lastPickFor(
  stored: unknown,
  folder: string | null | undefined,
): DesktopEnvironmentRef | null | undefined {
  if (!folder || typeof stored !== 'object' || stored === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(stored, folder)) return undefined;
  const pick = (stored as Record<string, unknown>)[folder];
  if (pick === null) return null;
  if (typeof pick !== 'object' || Array.isArray(pick)) return undefined;
  const { id, team } = pick as Record<string, unknown>;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && typeof team === 'boolean'
    ? { id, team }
    : undefined;
}

/** The stored picks with `pick` as the last one for `folder`. */
export function withLastPick(stored: unknown, folder: string, pick: DesktopEnvironmentRef | null): DesktopLastPicks {
  const kept: DesktopLastPicks = {};
  if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    for (const key of Object.keys(stored)) {
      const value = lastPickFor(stored, key);
      if (value !== undefined) kept[key] = value;
    }
  }
  kept[folder] = pick ? { id: pick.id, team: pick.team } : null;
  return kept;
}

/**
 * Whether a run for `choice` may start: any but a protected environment, which the person confirmed for this run; the
 * shell checks the confirmation again against the environment's key as it reads it.
 */
export function environmentReady(choice: DesktopEnvironmentChoice | null | undefined, confirmed: boolean): boolean {
  return !choice?.protected || confirmed;
}

/**
 * What a protected environment's confirmation says the run is limited to: the tests carrying one of its required tags,
 * and the setup and teardown projects they depend on, which Playwright runs whole.
 */
export function protectedRunScope(choice: Pick<EnvironmentForRun, 'requiredTags'>): string {
  return `Only the tests tagged ${choice.requiredTags.join(', ')} run against it, beside the setup and teardown projects they depend on, which Playwright runs whole.`;
}

/** Whether the environment loads an env file the linked folder does not hold (`envFiles`, from the folder's check). */
export function envFileMissing(
  choice: Pick<EnvironmentForRun, 'envFile'> | null | undefined,
  envFiles: readonly string[] | null | undefined,
): boolean {
  return !!choice?.envFile && !!envFiles && !envFiles.includes(choice.envFile);
}

/**
 * What the run's line says when the label the run reported does not resolve to the environment it was started for:
 * "Started for Staging; the config reported production". `reportedEnvironmentId` is the environment of the desktop
 * project the instance resolved the label to, which decides for one of its environments; a team environment is
 * matched by its key and aliases, ignoring case. Null when they agree or the run reported no label.
 */
export function environmentMismatch(
  startedFor: Pick<DesktopEnvironmentChoice, 'id' | 'team' | 'key' | 'name' | 'aliases'> | null | undefined,
  reported: { label: string | null; environmentId: number | null } | null | undefined,
): string | null {
  if (!startedFor || !reported?.label) return null;
  const agrees = startedFor.team
    ? resolveEnvironment(reported.label, [{ id: 1, key: startedFor.key, aliases: startedFor.aliases, position: 0 }]) ===
      1
    : reported.environmentId === startedFor.id;
  return agrees ? null : `Started for ${startedFor.name}; the config reported ${reported.label}`;
}
