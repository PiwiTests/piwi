/**
 * Imported first by a script whose output must not depend on the machine's time
 * zone: the offset-less timestamps it parses then read as UTC, as they do on
 * CI's runners. Node applies a `TZ` set at runtime to every later date.
 */
process.env.TZ = 'UTC';
