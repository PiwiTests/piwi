import OpenInIdeLink from '~/components/shared/OpenInIdeLink.vue';

// What the dashboard's window adds to the live view of its runs (`RunViewHost` of the run-ui layer): a worker in a
// window of its own, and a stop's place as a link that opens the file in the editor.
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.provide(RUN_VIEW_HOST, { workerWindows: true, placeLink: markRaw(OpenInIdeLink) });
});
