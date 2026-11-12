/**
 * The layers of a lane's view and the bounds a viewer of them shows: what `@piwitests/core/live-layers` reads with, in
 * a module that imports nothing, for a client loaded as plain TypeScript.
 */

/** A layer of a lane's view beside its images. */
export type LaneLayer = 'calls' | 'events' | 'text' | 'filmstrip';

/** Every layer, in the order a reader lists them. */
export const LANE_LAYERS: readonly LaneLayer[] = ['calls', 'events', 'text', 'filmstrip'];

/** The longest page's text a layer carries, in characters: a longer one is cut, and says so (`cut`). */
export const MAX_LANE_TEXT = 96 * 1024;

/** The most images a test's filmstrip keeps, the latest, and sends again to a viewer who comes later. */
export const MAX_FILMSTRIP = 40;
