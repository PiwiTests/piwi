/**
 * Who is present on a run, a worker's page and a stop, in the Runs window's words, from what a hub with the `presence`
 * feature says (`@piwitests/core/run-hub`): the tools that have the run open, those that watch a worker's page, and
 * the one that drives a stop. The window's own entries come marked `self`. Each kind is named in the window's own
 * words; an editor, or a kind of a newer hub, by the name the hub gives it.
 */
import type { HubPresence, HubStop } from '@piwitests/core/run-hub';
import { formatList, t } from './i18n.js';

/** A tool's name inside a sentence: `Piwi Picker`, `the desktop app`, `an agent`, an editor's own name. */
function toolName(tool: HubPresence): string {
  switch (tool.kind) {
    case 'picker':
      return t('runs_presencePicker');
    case 'desktop':
      return t('runs_presenceDesktop');
    case 'agent':
      return t('runs_presenceAgent');
    default:
      return tool.name;
  }
}

/** Each name once, in the order first given. */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * Who else has the run open, the window's own entry left out: `Also open in the desktop app · An agent follows this
 * run`. Null when nobody else has.
 */
export function presenceLine(presence: readonly HubPresence[] | undefined): string | null {
  const others = (presence ?? []).filter((tool) => !tool.self);
  const tools = unique(others.filter((tool) => tool.kind !== 'agent').map(toolName));
  const said: string[] = [];
  if (tools.length > 0) said.push(t('runs_presenceOpen', { tools: formatList(tools) }));
  if (others.some((tool) => tool.kind === 'agent')) said.push(t('runs_presenceAgentFollows'));
  return said.length > 0 ? said.join(' · ') : null;
}

/** Who watches a worker's page, this window first as `you`: `Watched by you and the desktop app`. Null for nobody. */
export function watchersLine(watchers: readonly HubPresence[] | undefined): string | null {
  const all = watchers ?? [];
  if (all.length === 0) return null;
  const names = unique([
    ...(all.some((tool) => tool.self) ? [t('runs_watcherYou')] : []),
    ...all.filter((tool) => !tool.self).map(toolName),
  ]);
  return t('runs_watchedBy', { who: formatList(names) });
}

/**
 * Who drives a stop, as the window says it, and which: this window (`self`), an agent, another tool; null while
 * nobody does.
 */
export function driverOf(stop: Pick<HubStop, 'driver'>): { who: 'self' | 'agent' | 'other'; words: string } | null {
  const { driver } = stop;
  if (!driver) return null;
  if (driver.self) return { who: 'self', words: t('runs_driverYou') };
  if (driver.kind === 'agent') return { who: 'agent', words: t('runs_driverAgent') };
  if (driver.kind === 'desktop') return { who: 'other', words: t('runs_driverDesktop') };
  const tool = toolName(driver);
  // The tool's name starts the sentence.
  return { who: 'other', words: t('runs_driverTool', { tool: tool.charAt(0).toUpperCase() + tool.slice(1) }) };
}
