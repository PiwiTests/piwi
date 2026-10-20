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

  const ipKey = `login:ip:${rateLimitClientIp(event)}`;
  const accountKey = `login:user:${username.toLowerCase()}`;
  // Throttle failed attempts, per source and per account, so credentials can't
  // be brute-forced online. Every attempt takes its slot before the password is
  // checked, so attempts sent together count as well; a valid login gives the
  // source's slot back and clears the account's counter.
  const limited = () =>
    rateLimitedError(event, [ipKey, accountKey], 'Too many failed attempts. Please wait before trying again.');
  if (!checkRateLimit(ipKey, 20, WINDOW_MS)) throw limited();
  if (!checkRateLimit(accountKey, 5, WINDOW_MS)) {
    releaseRateLimit(ipKey);
    throw limited();
  }

  const user = await verifyUser(username, password);
  if (!user) {
    throw apiError({
      statusCode: 401,
      message: 'Invalid username or password',
    });
  }

  releaseRateLimit(ipKey);
  resetRateLimit(accountKey);

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
