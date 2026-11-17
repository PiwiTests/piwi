import { runTargetRoute } from '../../../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: what the shell looks for a folder with (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. For a request the window still asks about, answers `{ projectId, specs, repositoryUrl, runFolders }`: its project, its spec paths, and with `{ hints: true }` what the team instance says helps find its folder (the project’s repository and the folders the person’s own runs came from). 404 for a request no longer asked about.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'folderSearch'));
