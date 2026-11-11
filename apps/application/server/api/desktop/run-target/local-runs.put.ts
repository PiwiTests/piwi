import { runTargetRoute } from '../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: the folders local runs are going in (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Body `{ folders }`: the folders the app’s local runs are going in, at most 200, whenever they change. A request waiting in one of them fails its checks until it frees up, and is checked again then.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'localRuns'));
