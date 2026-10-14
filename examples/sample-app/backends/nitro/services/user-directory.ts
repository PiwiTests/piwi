export interface User {
  id: number;
  name: string;
}

/** The users the slow page asks for, one per id. */
export const find = (id: number): User => ({ id, name: `User ${id}` });
