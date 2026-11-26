// No other site may frame the dashboard (clickjacking). The policy is a default, set before the route runs: a route
// that sets its own Content-Security-Policy (a sandboxed file, a share view, the desktop shell's page policy) replaces
// it. `X-Frame-Options`, which no route changes, is a route rule of `nuxt.config.ts`, so built assets carry it too.
export default eventHandler((event) => {
  event.res.headers.set('Content-Security-Policy', "frame-ancestors 'self'");
});
