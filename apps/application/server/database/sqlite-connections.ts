import type { Client, Config, InArgs, InStatement, Transaction, TransactionMode } from '@libsql/client';

/** How long a statement waits for a write lock held by another process. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Connections in the pool of the server's client: one for the open
 * transaction, one for every other statement.
 */
const POOL_CONNECTIONS = 2;

/**
 * Settings SQLite keeps per connection, run on each connection of the pool by
 * `configureSqliteConnections`.
 */
const CONNECTION_PRAGMAS = [
  'PRAGMA synchronous=NORMAL',
  // Enforce the ON DELETE actions declared in the schema. Delete paths still
  // remove child rows explicitly (see server/utils/retention.ts) so behavior
  // does not depend on this pragma.
  'PRAGMA foreign_keys=ON',
].join('; ');

/**
 * Settings of a local libSQL client with at most `connections` connections.
 * libSQL applies the busy timeout to every connection it opens.
 */
export function sqliteClientConfig(url: string, connections = POOL_CONNECTIONS): Config {
  return { url, concurrency: connections, timeout: BUSY_TIMEOUT_MS };
}

/** How long a write waits for this process's open transaction before it fails. */
const TRANSACTION_WAIT_MS = 30_000;

/** Whether `promise` settles within `ms`. */
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Call `release` once the transaction has committed or rolled back. */
function releaseWhenClosed(tx: Transaction, release: () => void): Transaction {
  const commit = tx.commit.bind(tx);
  const rollback = tx.rollback.bind(tx);
  const close = tx.close.bind(tx);
  const releaseIfClosed = () => {
    if (tx.closed) release();
  };
  tx.commit = () => commit().finally(releaseIfClosed);
  tx.rollback = () => rollback().finally(releaseIfClosed);
  tx.close = () => {
    close();
    release();
  };
  return tx;
}

/**
 * Give both connections of a local libSQL client created with
 * `sqliteClientConfig(url)` the same pragmas, and queue its writes behind an
 * open transaction. Call it while nothing else uses the client.
 *
 * The client keeps a pool of connections: a transaction holds one until it
 * ends, every other statement borrows one for its own run. An open transaction
 * holds SQLite's write lock across awaits while the client runs other
 * statements on the other connection, and the driver runs statements
 * synchronously: a write there cannot wait for the lock without blocking the
 * event loop the transaction needs to reach its COMMIT. Writes, batches and
 * other transactions therefore wait for the open transaction to end, so it is
 * the only one, and the other connection is always free. Reads (`select`) run
 * beside it, as WAL allows.
 */
export async function configureSqliteConnections(client: Client): Promise<void> {
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  const transaction = client.transaction.bind(client);

  // The pool reuses the connection it has until a transaction holds it, so
  // the pragmas run on that one, then on the second one, opened beside the
  // transaction. The pool keeps both and reuses them from then on.
  await client.executeMultiple(CONNECTION_PRAGMAS);
  const holding = await transaction('deferred');
  try {
    await client.executeMultiple(CONNECTION_PRAGMAS);
  } finally {
    holding.close();
  }

  /** Settles when the open transaction ends; null while none is open. */
  let open: Promise<void> | null = null;
  // Callers loop on `open` and run their statement right after the last check,
  // in the same tick, so no transaction can begin in between.
  const transactionEnded = async () => {
    if (open && !(await settlesWithin(open, TRANSACTION_WAIT_MS))) {
      throw new Error(`SQLite write waited ${TRANSACTION_WAIT_MS} ms for an open transaction`);
    }
  };
  const isRead = (stmt: InStatement | string) => /^\s*select\b/i.test(typeof stmt === 'string' ? stmt : stmt.sql);

  client.execute = async (stmt: InStatement | string, args?: InArgs) => {
    while (open && !isRead(stmt)) await transactionEnded();
    return typeof stmt === 'string' ? execute(stmt, args) : execute(stmt);
  };
  client.batch = async (stmts, mode) => {
    while (open) await transactionEnded();
    return batch(stmts, mode);
  };
  client.transaction = async (mode?: TransactionMode) => {
    while (open) await transactionEnded();
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    open = ended;
    const release = () => {
      if (open === ended) open = null;
      end();
    };
    try {
      return releaseWhenClosed(await transaction(mode), release);
    } catch (error) {
      release();
      throw error;
    }
  };
}
