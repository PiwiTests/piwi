import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3';
import * as users from '../../../services/user-directory';

/** A user by integer id; any other id is no route of the API, so a 404. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') ?? '';
  if (!/^-?\d+$/.test(id)) {
    setResponseStatus(event, 404);
    return { error: 'No such user' };
  }
  return users.find(Number(id));
});
