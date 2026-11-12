// What the dashboard's window adds to the live view of its runs (`RunViewHost` of the run-ui layer): a worker in a
// window of its own, a stop's place as a link that opens the file in the editor, loaded once a stop shows one, and
// **Inspect** of a watched lane, whose pages the desktop app's server reads from the test's own trace
// (`useDesktopLaneInspects`, shown by `DesktopRunLaneInspect`).
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.provide(RUN_VIEW_HOST, {
    workerWindows: true,
    placeLink: markRaw(defineAsyncComponent(() => import('~/components/shared/OpenInIdeLink.vue'))),
    inspect: {
      ...useDesktopLaneInspects().reader,
      view: markRaw(defineAsyncComponent(() => import('~/components/desktop/DesktopRunLaneInspect.vue'))),
      title:
        'The page at each call of this test, as a document, with a locator picker, read from its own trace on this machine',
    },
  });
});
