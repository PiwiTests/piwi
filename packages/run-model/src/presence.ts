/**
 * Who is present on a run, a worker's page and a stop, in a surface's words (`RunSpeaker`), from what a hub with the
 * `presence` feature says (`@piwitests/core/run-hub`): the tools that have the run open, those that watch a worker's
 * page, and the one that drives a stop. The surface's own entries come marked `self`. Each kind is named in the run
 * model's words; an editor, or a kind of a newer hub, by the name the hub gives it.
 */
import type { HubPresence, HubStop } from '@piwitests/core/run-hub';
import type { RunSpeaker } from './words';

/** A tool's name inside a sentence: `Piwi Picker`, `the desktop app`, `an agent`, an editor's own name. */
function toolName(tool: HubPresence, speaker: RunSpeaker): string {
  switch (tool.kind) {
    case 'picker':
      return speaker.say('runs_presencePicker');
    case 'desktop':
      return speaker.say('runs_presenceDesktop');
    case 'agent':
      return speaker.say('runs_presenceAgent');
    default:
      return tool.name;
  }
}

/** Each name once, in the order first given. */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * Who else has the run open, the surface's own entry left out: `Also open in the desktop app · An agent follows this
 * run`. Null when nobody else has.
 */
export function presenceLine(presence: readonly HubPresence[] | undefined, speaker: RunSpeaker): string | null {
  const others = (presence ?? []).filter((tool) => !tool.self);
  const tools = unique(others.filter((tool) => tool.kind !== 'agent').map((tool) => toolName(tool, speaker)));
  const said: string[] = [];
  if (tools.length > 0) said.push(speaker.say('runs_presenceOpen', { tools: speaker.list(tools) }));
  if (others.some((tool) => tool.kind === 'agent')) said.push(speaker.say('runs_presenceAgentFollows'));
  return said.length > 0 ? said.join(' · ') : null;
}

/** Who watches a worker's page, the surface first as `you`: `Watched by you and the desktop app`. Null for nobody. */
export function watchersLine(watchers: readonly HubPresence[] | undefined, speaker: RunSpeaker): string | null {
  const all = watchers ?? [];
  if (all.length === 0) return null;
  const names = unique([
    ...(all.some((tool) => tool.self) ? [speaker.say('runs_watcherYou')] : []),
    ...all.filter((tool) => !tool.self).map((tool) => toolName(tool, speaker)),
  ]);
  return speaker.say('runs_watchedBy', { who: speaker.list(names) });
}

/** Who drives a stop: the surface itself (`self`), an agent or another tool, and the sentence that says so. */
export interface StopDriver {
  who: 'self' | 'agent' | 'other';
  words: string;
}

/** Who drives a stop, as the surface says it; null while nobody does. */
export function driverOf(stop: Pick<HubStop, 'driver'>, speaker: RunSpeaker): StopDriver | null {
  const { driver } = stop;
  if (!driver) return null;
  if (driver.self) return { who: 'self', words: speaker.say('runs_driverYou') };
  if (driver.kind === 'agent') return { who: 'agent', words: speaker.say('runs_driverAgent') };
  if (driver.kind === 'desktop') return { who: 'other', words: speaker.say('runs_driverDesktop') };
  const tool = toolName(driver, speaker);
  // The tool's name starts the sentence.
  return {
    who: 'other',
    words: speaker.say('runs_driverTool', { tool: tool.charAt(0).toUpperCase() + tool.slice(1) }),
  };
}

/**
 * Whether Interact turned off gives a stop back: while the surface drives it (`driver`, as the hub says now), or while
 * nobody does and the surface's input reached it (`inputReached`).
 */
export function givesBack(driver: Pick<StopDriver, 'who'> | null, inputReached: boolean): boolean {
  return driver?.who === 'self' || (!driver && inputReached);
}
