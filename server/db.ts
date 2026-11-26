/**
 * The SQL connection, chosen by DATABASE_URL:
 *
 *   postgres://…               PostgreSQL (hosting, e.g. Vercel with Neon)
 *   mysql://… or mariadb://…   MariaDB (the client's own server, with the Docker image)
 *   empty                      a SQLite file through Node's built-in node:sqlite (local use, no setup)
 *
 * Statements are written once for all three: `?` placeholders (numbered for PostgreSQL here), ON
 * CONFLICT upserts (rewritten for MariaDB here, see `forMariaDb`). Where they differ the difference
 * lives here (schema, row order, locking); the few statements MariaDB has no form of (UPDATE …
 * RETURNING, a conditional upsert) are written per database in server/store.ts.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Row = Record<string, unknown>

export interface Query {
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>
  /** Runs a statement; resolves to the number of rows it inserted, changed or deleted. */
  run(sql: string, params?: unknown[]): Promise<number>
}

export interface Sql extends Query {
  readonly kind: 'sqlite' | 'postgres' | 'mariadb'
  /** Where it is, for the log (no password). */
  readonly where: string
  /** The column that keeps insertion order (SQLite: rowid; PostgreSQL, MariaDB: a serial column). */
  readonly seq: string
  /** Runs `fn` in one transaction: all of it or nothing. */
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>
  tableExists(name: string): Promise<boolean>
  close(): Promise<void>
}

/** Column types and table options per database. */
type Types = {
  /** Keys and indexed text (MariaDB can't index TEXT). */
  key: string
  /** The JSON records. */
  text: string
  /** The insertion-order column, with its leading comma; '' when the database has its own (SQLite). */
  seq: string
  int: string
  real: string
  /** After each CREATE TABLE (…). */
  tail: string
}

/** Tables holding one JSON record per row; `seq` is the order they were added in. */
const TABLES = ({ key, text, seq, int, real, tail }: Types) => `
  CREATE TABLE IF NOT EXISTS meta (key ${key} PRIMARY KEY, value ${text} NOT NULL)${tail};
  CREATE TABLE IF NOT EXISTS carriers (id ${key} PRIMARY KEY, data ${text} NOT NULL${seq})${tail};
  CREATE TABLE IF NOT EXISTS routes (id ${key} PRIMARY KEY, data ${text} NOT NULL${seq})${tail};
  CREATE TABLE IF NOT EXISTS scales (id ${key} PRIMARY KEY, data ${text} NOT NULL${seq})${tail};
  CREATE TABLE IF NOT EXISTS drivers (id ${key} PRIMARY KEY, data ${text} NOT NULL${seq})${tail};
  CREATE TABLE IF NOT EXISTS trucks (id ${key} PRIMARY KEY, data ${text} NOT NULL${seq})${tail};
  CREATE TABLE IF NOT EXISTS users (id ${key} PRIMARY KEY, data ${text} NOT NULL${seq})${tail};
  CREATE TABLE IF NOT EXISTS shipments (id ${key} PRIMARY KEY, carrier_id ${key} NOT NULL, created_at ${key} NOT NULL, data ${text} NOT NULL${seq})${tail};
  CREATE INDEX IF NOT EXISTS shipments_created ON shipments (created_at);
  CREATE INDEX IF NOT EXISTS shipments_carrier ON shipments (carrier_id);
  CREATE TABLE IF NOT EXISTS logs (id ${key} PRIMARY KEY, at ${key} NOT NULL, shipment_id ${key}, data ${text} NOT NULL${seq})${tail};
  CREATE TABLE IF NOT EXISTS sessions (token_hash ${key} PRIMARY KEY, user_id ${key} NOT NULL, created_at ${int} NOT NULL, last_used_at ${int} NOT NULL)${tail};
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
  CREATE TABLE IF NOT EXISTS product_prices (bar_code ${key} PRIMARY KEY, price ${real} NOT NULL, vat_type INTEGER NOT NULL)${tail};
  CREATE TABLE IF NOT EXISTS login_codes (key ${key} PRIMARY KEY, data ${text} NOT NULL, expires ${int} NOT NULL)${tail};
  CREATE TABLE IF NOT EXISTS locks (id ${key} PRIMARY KEY, holder ${key} NOT NULL, expires ${int} NOT NULL)${tail};
  INSERT INTO meta (key, value) VALUES ('rev', '0') ON CONFLICT (key) DO NOTHING;
`

export async function openSql(url = process.env.DATABASE_URL?.trim(), file?: string): Promise<Sql> {
  if (!url) return openSqlite(file!)
  return /^(mysql|mariadb):\/\//i.test(url) ? openMariaDb(url) : openPostgres(url)
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
  const on = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }): Query => ({
    all: async <T,>(sql: string, params: unknown[] = []) => (await c.query(numbered(sql), params)).rows as T[],
    run: async (sql: string, params: unknown[] = []) => (await c.query(numbered(sql), params)).rowCount ?? 0,
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
  // Several server copies can start at once; CREATE TABLE IF NOT EXISTS isn't safe to run side by side
  // in PostgreSQL (duplicate key on pg_type), so one copy at a time creates the tables.
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query('SELECT pg_advisory_xact_lock(4242001)')
    await c.query(TABLES({ key: 'TEXT', text: 'TEXT', seq: ', seq BIGSERIAL', int: 'BIGINT', real: 'DOUBLE PRECISION', tail: '' }))
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
  return db
}

/* ------------------------------- MariaDB -------------------------------- */

/**
 * A statement as MariaDB (and MySQL) takes it: the `key` column quoted (a reserved word there) and
 * ON CONFLICT upserts as ON DUPLICATE KEY UPDATE. An ON CONFLICT … WHERE has no MariaDB form: the
 * one statement that has it (claiming a lock) is written for MariaDB in server/store.ts.
 */
export function forMariaDb(sql: string): string {
  return sql
    .replace(/\bkey\b/g, '`key`')
    .replace(/ON CONFLICT \(([^)]*)\) DO NOTHING/g, (_, k: string) => `ON DUPLICATE KEY UPDATE ${k} = ${k}`)
    .replace(/ON CONFLICT \([^)]*\) DO UPDATE SET ([\s\S]*)$/, (_, set: string) => `ON DUPLICATE KEY UPDATE ${set.replace(/\bexcluded\.(`?\w+`?)/g, 'VALUES($1)')}`)
    .replace(/\bAS INTEGER\b/g, 'AS SIGNED')
    .replace(/\bAS TEXT\b/g, 'AS CHAR')
}

async function openMariaDb(url: string): Promise<Sql> {
  const { default: mariadb } = await import('mariadb')
  const u = new URL(url)
  const ssl = u.searchParams.get('ssl')
  const pool = mariadb.createPool({
    host: u.hostname || 'localhost',
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    // Off unless asked for (?ssl=true); ?ssl=verify also checks the server's certificate.
    ssl: ssl === 'true' || ssl === '1' ? { rejectUnauthorized: false } : ssl === 'verify' ? true : undefined,
    charset: 'utf8mb4',
    connectionLimit: 5,
    // BIGINT (ms timestamps) as numbers, not BigInt.
    bigIntAsNumber: true,
    insertIdAsNumber: true,
  })
  type Conn = { query: (s: string, p?: unknown[]) => Promise<unknown> }
  const on = (c: Conn): Query => ({
    all: async <T,>(s: string, params: unknown[] = []) => [...((await c.query(forMariaDb(s), params)) as T[])],
    run: async (s: string, params: unknown[] = []) => Number(((await c.query(forMariaDb(s), params)) as { affectedRows?: number }).affectedRows ?? 0),
  })
  const db: Sql = {
    kind: 'mariadb',
    where: url.replace(/\/\/[^@/]*@/, '//…@'),
    seq: 'seq',
    ...on(pool),
    async tx(fn) {
      const c = await pool.getConnection()
      try {
        await c.beginTransaction()
        const out = await fn(on(c))
        await c.commit()
        return out
      } catch (e) {
        await c.rollback().catch(() => {})
        throw e
      } finally {
        await c.release()
      }
    },
    async tableExists(name) {
      return (await db.all('SELECT 1 AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name])).length > 0
    },
    close: () => pool.end(),
  }
  // As for PostgreSQL: one server copy at a time creates the tables. A statement at a time (MariaDB
  // takes one per call); CREATE TABLE commits on its own there, so a lock, not a transaction.
  const c = await pool.getConnection()
  try {
    await c.query("SELECT GET_LOCK('hc_waybill_schema', 60)")
    const tail = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin'
    const ddl = TABLES({ key: 'VARCHAR(255)', text: 'LONGTEXT', seq: ', seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE', int: 'BIGINT', real: 'DOUBLE', tail })
    for (const stmt of ddl.split(';').map((x) => x.trim()).filter(Boolean)) await c.query(forMariaDb(stmt))
  } finally {
    await c.query("SELECT RELEASE_LOCK('hc_waybill_schema')").catch(() => {})
    await c.release()
  }
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
  sql.exec(TABLES({ key: 'TEXT', text: 'TEXT', seq: '', int: 'INTEGER', real: 'REAL', tail: '' }))

  const q: Query = {
    all: async <T,>(s: string, params: unknown[] = []) => sql.prepare(s).all(...(params as never[])) as T[],
    run: async (s: string, params: unknown[] = []) => Number(sql.prepare(s).run(...(params as never[])).changes),
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
