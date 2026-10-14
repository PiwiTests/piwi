// The whole Piwi integration: Nitro loads every file of plugins/ on startup. Outside production it adds X-Piwi-Logs
// (the Warning and Error entries a request logs through consola, and its unhandled error) and X-Piwi-Trace (the
// request's spans) to every response, serves /__piwi/manifest, and applies the server probes PIWI_PROBE_SECRET signs
// when PIWI_SERVER_PROBES=true.
export { default } from '@piwitests/instrumentation-nitro';
