// Ambient types for the Nitro internal virtual module holding compiled route
// metas. It has no shipped types; we read it to enforce each route's
// `x-required-permission` (see server/utils/route-required-permission.ts).
declare module '#nitro/virtual/routing-meta' {
  export const handlersMeta: Array<{
    route?: string;
    method?: string;
    meta?: { openAPI?: Record<string, unknown> } | null;
  }>;
}
