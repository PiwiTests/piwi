import { getDatabase } from '../../database';
import { authUserView, verifyUser, setUserSession, isAuthEnabled } from '../../utils/auth';
import {
  checkRateLimit,
  rateLimitClientIp,
  rateLimitedError,
  releaseRateLimit,
  resetRateLimit,
} from '../../utils/rate-limit';
import { z } from 'zod';

const WINDOW_MS = 15 * 60 * 1000;

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Login',
    description:
      'Authenticates a user with username and password credentials and creates a session. Returns the user as `GET /api/auth/me` does.',
    security: [],
  },
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export default eventHandler(async (event) => {
  if (!isAuthEnabled(event)) {
    throw apiError({
      statusCode: 400,
      message: 'Authentication is not enabled',
    });
  }

  const body = await readBody(event);
  const validation = loginSchema.safeParse(body);

  if (!validation.success) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid request body',
      data: validation.error.issues,
    });
  }

  const { username, password } = validation.data;

  const address = rateLimitClientIp(event);
  const account = username.toLowerCase();
  const ipKey = `login:ip:${address}`;
  // An address never holds an `@`, so the last one splits this key unambiguously.
  const accountAddressKey = `login:user-ip:${account}@${address}`;
  const accountKey = `login:user:${account}`;
  // Throttle failed attempts so credentials can't be brute-forced online: per
  // source, per account from one source, and a ceiling per account across every
  // source, so failures from elsewhere never lock the owner out below it. Every
  // attempt takes its slots before the password is checked, so attempts sent
  // together count as well; a refused attempt gives back the slots it took.
  const buckets: [key: string, limit: number][] = [
    [ipKey, 20],
    [accountAddressKey, 5],
    [accountKey, 50],
  ];
  const taken: string[] = [];
  for (const [key, limit] of buckets) {
    if (!checkRateLimit(key, limit, WINDOW_MS)) {
      for (const slot of taken) releaseRateLimit(slot);
      throw rateLimitedError(event, [key], 'Too many failed attempts. Please wait before trying again.');
    }
    taken.push(key);
  }

  // A check that throws (a busy server's 503) found no wrong password, so it gives its slots back.
  const user = await verifyUser(event, username, password).catch((error: unknown) => {
    for (const slot of taken) releaseRateLimit(slot);
    throw error;
  });
  if (!user) {
    throw apiError({
      statusCode: 401,
      message: 'Invalid username or password',
    });
  }

  // A valid login does not count: it gives back its slots and clears the
  // account's failures from this source.
  releaseRateLimit(ipKey);
  releaseRateLimit(accountKey);
  resetRateLimit(accountAddressKey);

  const view = await authUserView(await getDatabase(), user);

  // Set session
  await setUserSession(event, {
    userId: user.id,
    sessionEpoch: user.sessionEpoch,
  });

  return {
    success: true,
    user: view,
  };
});
