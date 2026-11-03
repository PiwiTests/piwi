import { z } from 'zod';

// Zod parses in the browser without compiling code: its JIT probes `new Function`, which the desktop build's
// Content-Security-Policy refuses and reports as a violation. Set at module evaluation, before any other plugin's
// imports build a schema, since a schema reads the setting when it is created.
z.config({ jitless: true });

export default defineNuxtPlugin(() => {});
