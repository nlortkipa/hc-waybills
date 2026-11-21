/**
 * The SQL connection: PostgreSQL when DATABASE_URL is set (hosting, e.g. Vercel with Neon), otherwise
 * a SQLite file through Node's built-in node:sqlite (local use, no setup).
 *
 * Statements are written once for both: `?` placeholders (numbered for PostgreSQL here), ON CONFLICT
 * upserts, RETURNING. Where the two differ the difference lives here (schema, row order, locking).
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Row = Record<string, unknown>

export interface Query {
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<void>
}

export interface Sql extends Query {
  readonly kind: 'sqlite' | 'postgres'
  /** Where it is, for the log (no password). */
  readonly where: string
  /** The column that keeps insertion order (SQLite: rowid; PostgreSQL: a serial column). */
  readonly seq: string
  /** Runs `fn` in one transaction: all of it or nothing. */
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>
  tableExists(name: string): Promise<boolean>
  close(): Promise<void>
}

/** Tables holding one JSON record per row; `seq` is the order they were added in. */
const TABLES = (seq: string, int: string, real: string) => `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS carriers (id TEXT PRIMARY KEY, data TEXT NOT NULL${seq});
  CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, data TEXT NOT NULL${seq});
  CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, data TEXT NOT NULL${seq});
  CREATE TABLE IF NOT EXISTS trucks (id TEXT PRIMARY KEY, data TEXT NOT NULL${seq});
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL${seq});
  CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, carrier_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL${seq});
  CREATE INDEX IF NOT EXISTS shipments_created ON shipments (created_at);
  CREATE INDEX IF NOT EXISTS shipments_carrier ON shipments (carrier_id);
  CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, at TEXT NOT NULL, shipment_id TEXT, data TEXT NOT NULL${seq});
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at ${int} NOT NULL, last_used_at ${int} NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
  CREATE TABLE IF NOT EXISTS product_prices (bar_code TEXT PRIMARY KEY, price ${real} NOT NULL, vat_type INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS login_codes (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires ${int} NOT NULL);
  CREATE TABLE IF NOT EXISTS locks (id TEXT PRIMARY KEY, holder TEXT NOT NULL, expires ${int} NOT NULL);
  INSERT INTO meta (key, value) VALUES ('rev', '0') ON CONFLICT (key) DO NOTHING;
`

export async function openSql(url = process.env.DATABASE_URL?.trim(), file?: string): Promise<Sql> {
  return url ? openPostgres(url) : openSqlite(file!)
}

/* ------------------------------ PostgreSQL ------------------------------ */

async function openPostgres(url: string): Promise<Sql> {
  const { default: pg } = await import('pg')
  // BIGINT (ms timestamps) as numbers, not strings.
  pg.types.setTypeParser(20, (v) => Number(v))
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || /sslmode=disable/.test(url)
  const pool = new pg.Pool({
    connectionString: url,
    // Hosted databases (Neon, Supabase…) need TLS; a local one usually has none.
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  })
  pool.on('error', (e) => console.error('[db] idle connection error:', e.message))
  const numbered = (sql: string) => {
    let i = 0
    return sql.replace(/\?/g, () => `$${++i}`)
  }
  const on = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Query => ({
    all: async <T,>(sql: string, params: unknown[] = []) => (await c.query(numbered(sql), params)).rows as T[],
    run: async (sql: string, params: unknown[] = []) => void (await c.query(numbered(sql), params)),
  })
  const db: Sql = {
    kind: 'postgres',
    where: url.replace(/\/\/[^@/]*@/, '//…@'),
    seq: 'seq',
    ...on(pool),
    async tx(fn) {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const out = await fn(on(c))
        await c.query('COMMIT')
        return out
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        c.release()
      }
    },
    async tableExists(name) {
      return (await db.all('SELECT to_regclass(?) AS t', [name]))[0]?.t != null
    },
    close: () => pool.end(),
  }
  await pool.query(TABLES(', seq BIGSERIAL', 'BIGINT', 'DOUBLE PRECISION'))
  return db
}

/* -------------------------------- SQLite -------------------------------- */

async function openSqlite(file: string): Promise<Sql> {
  const { DatabaseSync } = await import('node:sqlite')
  mkdirSync(dirname(file), { recursive: true })
  const sql = new DatabaseSync(file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* not fatal (e.g. a file owned by another user) */
  }
  sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  sql.exec(TABLES('', 'INTEGER', 'REAL'))

  const q: Query = {
    all: async <T,>(s: string, params: unknown[] = []) => sql.prepare(s).all(...(params as never[])) as T[],
    run: async (s: string, params: unknown[] = []) => void sql.prepare(s).run(...(params as never[])),
  }
  // One connection: a transaction holds it until it ends, and everything else waits for it.
  let gate: Promise<unknown> = Promise.resolve()
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = gate.then(fn)
    gate = p.catch(() => {})
    return p
  }
  return {
    kind: 'sqlite',
    where: file,
    seq: 'rowid',
    all: (s, p) => serial(() => q.all(s, p)),
    run: (s, p) => serial(() => q.run(s, p)),
    tx: (fn) =>
      serial(async () => {
        sql.exec('BEGIN IMMEDIATE')
        try {
          const out = await fn(q)
          sql.exec('COMMIT')
          return out
        } catch (e) {
          sql.exec('ROLLBACK')
          throw e
        }
      }),
    tableExists: (name) => serial(async () => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)),
    close: async () => sql.close(),
  }
}
