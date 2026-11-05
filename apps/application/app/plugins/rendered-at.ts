/** Records when the server rendered the page (`useRenderedAt`), on the server, where the page's data is read. */
export default defineNuxtPlugin(() => {
  useRenderedAt();
});
