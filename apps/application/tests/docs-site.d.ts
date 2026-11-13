// VitePress is installed with the docs site alone (`apps/docs` is not a workspace). The tests read the site's plain
// helpers (`.vitepress/page-meta.mts`), whose VitePress types this leaves untyped.
declare module 'vitepress' {
  export type HeadConfig = any;
  export type PageData = any;
  export type SiteConfig = any;
}
