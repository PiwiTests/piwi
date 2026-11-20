import { runTargetRoute } from '../../../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: what the shell starts (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. After **Run**, answers `{ instance, token, projectId, folder, args, runVariables, environment }` once: the instance and the request token the reporter uploads the run with, the project, the linked folder **Run** approved, the arguments after `playwright test` it approved, and the run variables and the environment (`{ id, key, name, protected, requiredTags, envFile }`, null for none) its confirmation showed. The shell checks them again, sets the run variables and `PIWI_ENVIRONMENT` to the environment’s key on the process, and limits a protected environment’s run with a `--grep-invert` to the tests carrying one of its required tags, beside the setup and teardown projects they depend on, which Playwright runs whole. 404 for a request with no run to start, or asked a second time.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'launch'));
