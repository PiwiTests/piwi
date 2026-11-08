import { runTargetRoute } from '../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: the linked folders (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Body `{ links }`: the folders linked on this machine for the connected instance’s projects (project id to folder), which the checks of each request read and the instance hears as the projects this app has a folder for.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'links'));
