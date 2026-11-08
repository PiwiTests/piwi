import { runTargetRoute } from '../../../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: what the shell starts (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. After **Run**, answers `{ instance, token, projectId, folder, args }` once: the instance and the request token the reporter uploads the run with, the project, the linked folder **Run** approved, and the arguments after `playwright test` it approved. 404 for a request with no run to start, or asked a second time.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'launch'));
