/**
 * Desktop shell only: what the window heard for **Inspect** of each lane it has it open on, by `desktopLaneKey`, each
 * replaced whole as something comes. The run-ui layer's live view opens and closes Inspect and tells this store what
 * the window's stream says of each lane (`RunViewInspect`, which `plugins/run-view-host.ts` provides): each `inspect`
 * it says (`hearDesktopInspect`), and what the server listed each time it took the lane (`hearDesktopCalls`). The pages
 * stay on the server; a lane's Inspect view reads what is heard here (`inspectOf`).
 */
import { desktopLaneKey } from '@piwitests/run-ui/run-view';
import type { DesktopInspectCalls } from '#shared/desktop-runs';
import {
  NO_DESKTOP_INSPECT,
  hearDesktopCalls,
  hearDesktopInspect,
  type DesktopLaneInspect,
  type HeardSnapshot,
} from '~/utils/live-inspect';

const inspects = reactive<Record<string, DesktopLaneInspect>>({});

/** What the layer's live view tells of a lane's Inspect, kept here. */
const reader: Omit<RunViewInspect, 'view' | 'title'> = {
  opened(key) {
    inspects[key] = markRaw({ ...NO_DESKTOP_INSPECT });
  },
  heard(key, value) {
    const kept = inspects[key];
    if (!kept || (value.attempt !== null && typeof value.attempt !== 'string')) return;
    const snapshot = value.snapshot as HeardSnapshot | undefined;
    const event = {
      attempt: value.attempt,
      ...(snapshot && typeof snapshot.call === 'string' && typeof snapshot.phase === 'string' ? { snapshot } : {}),
      ...(typeof value.refused === 'string' ? { refused: value.refused } : {}),
    };
    inspects[key] = markRaw(hearDesktopInspect(kept, event));
  },
  async taken(key, at) {
    const asked = inspects[key]?.said;
    if (asked === undefined) return;
    try {
      const calls = await $fetch<DesktopInspectCalls>('/api/desktop/runs/inspect/calls', {
        query: { viewer: at.viewer, ref: at.ref, lane: at.lane },
      });
      const kept = inspects[key];
      if (kept && at.current()) inspects[key] = markRaw(hearDesktopCalls(kept, calls, asked));
    } catch {
      // What the server read so far comes again as it reads more.
    }
  },
  closed(key) {
    delete inspects[key];
  },
};

export function useDesktopLaneInspects() {
  return {
    reader,
    /** What the window heard for Inspect of a lane of a run; null while it does not have it open. */
    inspectOf(ref: string, lane: number): DesktopLaneInspect | null {
      return inspects[desktopLaneKey(ref, lane)] ?? null;
    },
  };
}
