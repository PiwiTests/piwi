import { runTargetRoute } from '../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: use the kept key (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Body `{ instance, key, links }`: the instance and the key the shell keeps in the OS keychain, and the folders linked on this machine (`links`, project id of the instance to folder). The server takes run requests from that instance with that key until the shell disconnects it or the instance revokes it. Sent after each start of the server and once the shell kept a new key.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'useKey'));
