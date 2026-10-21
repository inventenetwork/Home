import type { Config } from '../config.js';

/**
 * Tiny database adapter so the same SQL runs on:
 *  - PGlite (embedded Postgres) for local development and tests, no install needed
 *  - node-postgres (real Postgres) in production when DATABASE_URL is set
 */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Run one or more statements with no parameters (used by migrations). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside one transaction on one connection: commits if it returns, rolls back if it throws.
   * (Calling BEGIN/COMMIT through `query` is NOT safe on a connection pool: each call may use a different connection.)
   */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Runner = { query(sql: string, params?: any[]): Promise<any> };
type Exec = Pick<Db, 'query' | 'exec'>;

function pgRunner(q: Runner): Exec {
  return {
    async query(sql, params) {
      const res = await q.query(sql, params as any[]);
      return { rows: res.rows as any[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql) {
      await q.query(sql);
    },
  };
}

function pgliteRunner(q: { query(sql: string, params?: any[]): Promise<any>; exec(sql: string): Promise<any> }): Exec {
  return {
    async query(sql, params) {
      const res = await q.query(sql, params as any[]);
      // PGlite reports affectedRows = 0 for SELECT, so prefer the row count whenever rows came back
      // (this also matches UPDATE/INSERT ... RETURNING). Plain UPDATE/DELETE return no rows: use affectedRows.
      const rows = res.rows as any[];
      return { rows, rowCount: rows.length > 0 ? rows.length : (res.affectedRows ?? 0) };
    },
    async exec(sql) {
      await q.exec(sql);
    },
  };
}

export async function createDb(opts: { url?: string; dataDir?: string; poolMax?: number }): Promise<Db> {
  if (opts.url) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: opts.url, max: opts.poolMax ?? 5, idleTimeoutMillis: 10_000 });
    return {
      ...pgRunner(pool as unknown as Runner),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const inner: Db = { ...pgRunner(client as unknown as Runner), tx: (f) => f(inner), close: async () => {} };
          const out = await fn(inner);
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  if (opts.dataDir) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(opts.dataDir, { recursive: true });
  }
  const pglite = new PGlite(opts.dataDir); // no dataDir = in-memory (tests)
  await pglite.waitReady;
  return {
    ...pgliteRunner(pglite),
    tx: (fn) =>
      pglite.transaction(async (t) => {
        const inner: Db = { ...pgliteRunner(t as any), tx: (f) => f(inner), close: async () => {} };
        return fn(inner);
      }),
    close: () => pglite.close(),
  };
}

export function createDbFromConfig(cfg: Config): Promise<Db> {
  return createDb({ url: cfg.DATABASE_URL || undefined, dataDir: cfg.DATABASE_URL ? undefined : cfg.PGLITE_DIR, poolMax: cfg.DB_POOL_MAX });
}
