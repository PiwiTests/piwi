/**
 * The ports a JetBrains IDE's built-in server takes: the first free one of
 * 63342…63361 (the IDE tries 20 from its default port), so a second IDE
 * running is on 63343. Open in editor asks the Piwi JetBrains plugin on these,
 * and the desktop build's Content-Security-Policy lets the page reach these,
 * and no other port, on the loopback interface.
 */
export const JETBRAINS_DEFAULT_PORT = 63342;

export const JETBRAINS_PORTS: readonly number[] = Array.from({ length: 20 }, (_, i) => JETBRAINS_DEFAULT_PORT + i);
