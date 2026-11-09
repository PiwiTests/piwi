import { DEFAULT_INSECURE_SECRET } from '../utils/crypto';

/** The shortest session secret the cookie sealing accepts (iron's minimum password length). */
const MIN_AUTH_SECRET_LENGTH = 32;

// Fail closed at startup when authentication is enabled without a secure secret.
//
// An enabled dashboard whose session secret is missing or the built-in default
// has forgeable administrator sessions, so the server refuses to start rather
// than serve it; one shorter than the cookie sealing accepts would fail every
// sign-in. `PIWI_AUTH_*` from the runtime environment is authoritative: on the
// published image the config is baked at build time (with the variables unset),
// and server-side enforcement in `utils/auth.ts` reads the same env.
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig();
  const authEnabled = process.env.PIWI_AUTH_ENABLED === 'true' || String(config.authEnabled) === 'true';
  if (!authEnabled) return;

  const generate =
    "Generate a strong value with node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\" " +
    'and set PIWI_AUTH_SECRET before starting the server.';
  const secret = process.env.PIWI_AUTH_SECRET || config.authSecret;
  if (!secret || secret === DEFAULT_INSECURE_SECRET) {
    throw new Error(
      'Authentication is enabled but PIWI_AUTH_SECRET is missing or set to the built-in default. ' + generate,
    );
  }
  if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `Authentication is enabled but PIWI_AUTH_SECRET is shorter than ${MIN_AUTH_SECRET_LENGTH} characters: ` +
        `the session cookie needs at least ${MIN_AUTH_SECRET_LENGTH}. ` +
        generate,
    );
  }
});
