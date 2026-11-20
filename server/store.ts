/**
 * The database: SQLite through Node's built-in node:sqlite (no dependencies).
 *
 * Only what RS.ge doesn't have is stored. RS.ge's data (products, car numbers, waybills, the seller)
 * is read from RS.ge on demand and kept in memory (server/rscache.ts). A product's unit price and VAT
 * type are shown on RS.ge's portal but its API doesn't carry them, so they are stored here by bar code.
 *
 * Each record is one row holding its JSON, so a change writes only the rows it touches,
 * inside a transaction. A copy of the data is kept in memory for fast reads; every write
 * goes to SQLite first and reaches the copy only after it committed.
 *
 * On first start an existing db.json (the previous storage) is imported and renamed to
 * db.json.imported. The RS.ge service user and the SMS account are not stored: they come from .env
 * (server/config.ts). The file is readable by its owner only.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RS_LIVE_FIELDS, type IntegrationLog, type RsSettings, type SmsSettings, type StoredDatabase as Database } from '../src/types.ts'
import { defaultSmsSettings } from '../src/lib/sms.ts'
import { defaultRsSettings } from '../src/lib/rs.ts'
import { createSeed, migrate, storedShipment } from './seed.ts'

const DATA = join(import.meta.dirname, 'data')
/** HC_DB_FILE used to name the JSON file; a .json value now means "the .db next to it". */
const ENV_FILE = process.env.HC_DB_FILE
const FILE = ENV_FILE ? ENV_FILE.replace(/\.json$/, '.db') : join(DATA, 'hc.db')
const OLD_JSON = ENV_FILE?.endsWith('.json') ? ENV_FILE : join(dirname(FILE), 'db.json')
/** Data entered before the server existed, shared between browsers by the old dev setup. */
const LEGACY = join(import.meta.dirname, '..', '.mockdb', 'db.json')

/** Log entries kept: the last LOG_LIMIT calls that do something, plus the last READ_LOG_LIMIT RS.ge read-backs. */
const LOG_LIMIT = 300
const READ_LOG_LIMIT = 100

/** The newest entries of each kind, in the order given (newest first). */
function trimLogs(logs: IntegrationLog[]): IntegrationLog[] {
  let calls = 0
  let reads = 0
  return logs.filter((l) => (l.readBack ? ++reads <= READ_LOG_LIMIT : ++calls <= LOG_LIMIT))
}

/** A session ends after this long without use, or this long after login, whichever comes first. */
const SESSION_IDLE_MS = 30 * 86400_000
const SESSION_MAX_MS = 90 * 86400_000
/** last_used_at is written at most this often, so polling doesn't write on every request. */
const SESSION_TOUCH_MS = 3600_000

type RecordCol = 'carriers' | 'routes' | 'drivers' | 'trucks' | 'users'
export type StoredCol = RecordCol | 'shipments'
type MetaKey = 'rs' | 'sms'

mkdirSync(dirname(FILE), { recursive: true })
const sql = new DatabaseSync(FILE)
try {
  chmodSync(FILE, 0o600)
} catch {
  /* not fatal (e.g. a file owned by another user) */
}
sql.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS carriers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS trucks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, carrier_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS shipments_created ON shipments (created_at);
  CREATE INDEX IF NOT EXISTS shipments_carrier ON shipments (carrier_id);
  CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, at TEXT NOT NULL, shipment_id TEXT, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
  CREATE TABLE IF NOT EXISTS product_prices (bar_code TEXT PRIMARY KEY, price REAL NOT NULL, vat_type INTEGER NOT NULL);
`)

/* ------------------------------ Low level ------------------------------ */

const RECORD_COLS: RecordCol[] = ['carriers', 'routes', 'drivers', 'trucks', 'users']

function getMeta<T>(key: string): T | undefined {
  const row = sql.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as T) : undefined
}
const setMetaStmt = sql.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
const setMeta = (key: string, value: unknown) => setMetaStmt.run(key, JSON.stringify(seal(key, value)))

/* The services' accounts live in .env (server/config.ts). Older versions stored them here: never written again. */
const ENV_ONLY: Record<MetaKey, string[]> = { rs: ['su', 'sp'], sms: ['apiKey', 'sender'] }
const omit = <T,>(value: T, keys: readonly string[]): T => (value ? (Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T) : value)
function seal(key: string, value: unknown) {
  // What RS.ge says about the account is never stored: it is read again from RS.ge.
  if (key === 'rs') value = omit(value, RS_LIVE_FIELDS)
  return key in ENV_ONLY ? omit(value, ENV_ONLY[key as MetaKey]) : value
}

function writeRow(col: StoredCol, rec: { id: string }) {
  if (col === 'shipments') {
    const s = rec as Database['shipments'][number]
    sql
      .prepare('INSERT INTO shipments (id, carrier_id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET carrier_id = excluded.carrier_id, data = excluded.data')
      .run(s.id, s.carrierId, s.createdAt, JSON.stringify(s))
  } else {
    sql.prepare(`INSERT INTO ${col} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(rec.id, JSON.stringify(rec))
  }
}

function writeLog(l: IntegrationLog) {
  sql.prepare('INSERT OR REPLACE INTO logs (id, at, shipment_id, data) VALUES (?, ?, ?, ?)').run(l.id, l.at, l.shipmentId ?? null, JSON.stringify(l))
}

const parseRows = <T,>(rows: unknown[]) => (rows as { data: string }[]).map((r) => JSON.parse(r.data) as T)

const tableExists = (name: string) => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

function readAll(): Database | null {
  const version = getMeta<number>('version')
  if (version == null) return null
  return {
    version,
    carriers: parseRows(sql.prepare('SELECT data FROM carriers ORDER BY rowid').all()),
    routes: parseRows(sql.prepare('SELECT data FROM routes ORDER BY rowid').all()),
    drivers: parseRows(sql.prepare('SELECT data FROM drivers ORDER BY rowid').all()),
    trucks: parseRows(sql.prepare('SELECT data FROM trucks ORDER BY rowid').all()),
    users: parseRows(sql.prepare('SELECT data FROM users ORDER BY rowid').all()),
    shipments: parseRows(sql.prepare('SELECT data FROM shipments ORDER BY created_at DESC, rowid DESC').all()),
    logs: trimLogs(parseRows(sql.prepare('SELECT data FROM logs ORDER BY rowid DESC').all())),
    // Before v19: the one admin-set cargo, which migrate() turns into a product.
    ...(version < 19 && { cargo: getMeta('cargo') }),
    // Before v24 products were stored; migrate() reads them to point route lines at their bar codes.
    ...(version < 24 && { products: tableExists('products') ? parseRows(sql.prepare('SELECT data FROM products ORDER BY rowid').all()) : [] }),
    rs: { ...defaultRsSettings(), ...omit(getMeta<RsSettings>('rs'), ENV_ONLY.rs) },
    // Missing before v17 (migrate() adds it); defaults also cover a v17 file written without it.
    sms: { ...defaultSmsSettings(), ...omit(getMeta<SmsSettings>('sms'), ENV_ONLY.sms) },
  }
}

/** Survives restarts so a client's last-seen revision never matches stale data. */
let rev = getMeta<number>('rev') ?? 0
/** New for every database (a deleted file starts over at a new id, not at an old revision). */
let instance = getMeta<string>('instance') ?? ''

/** Runs `fn` in one transaction and bumps the revision. Throws (and changes nothing) if any statement fails. */
function tx(fn: () => void, bump = true) {
  sql.exec('BEGIN IMMEDIATE')
  try {
    fn()
    if (bump) setMeta('rev', rev + 1)
    sql.exec('COMMIT')
  } catch (e) {
    sql.exec('ROLLBACK')
    throw e
  }
  if (bump) rev++
}

function replaceAll(db: Database) {
  tx(() => {
    for (const t of [...RECORD_COLS, 'shipments', 'logs']) sql.exec(`DELETE FROM ${t}`)
    // Products are RS.ge's only since v24.
    sql.exec('DROP TABLE IF EXISTS products')
    for (const col of RECORD_COLS) for (const r of db[col]) writeRow(col, r)
    for (const s of db.shipments) writeRow('shipments', storedShipment(s))
    for (const l of trimLogs(db.logs).reverse()) writeLog(l)
    setMeta('version', db.version)
    sql.prepare("DELETE FROM meta WHERE key IN ('settings', 'cargo')").run()
    setMeta('rs', db.rs)
    setMeta('sms', db.sms)
    if (!instance) setMeta('instance', (instance = randomBytes(6).toString('base64url')))
  })
}

/* ------------------------------- Startup ------------------------------- */

/** The JSON file the server used before SQLite, if there is one: data plus plain-text session tokens. */
function readOldJson(): { db: Database; sessions: Record<string, string>; file: string } | null {
  for (const file of [OLD_JSON, LEGACY]) {
    if (!existsSync(file)) continue
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { db?: Database; sessions?: Record<string, string> } & Partial<Database>
    // db.json is { db, sessions }; the legacy file is the database itself.
    const db = migrate((raw.db ?? raw) as Database)
    if (!db) throw new Error(`[db] ${file} has schema v${(raw.db ?? raw).version}, which can't be upgraded`)
    return { db, sessions: raw.sessions ?? {}, file }
  }
  return null
}

let mem: Database = (() => {
  const existing = readAll()
  if (existing) {
    const db = migrate(existing)
    // Never silently start over on top of real data: stop and let a person look.
    if (!db) throw new Error(`[db] ${FILE} has schema v${existing.version}, which can't be upgraded`)
    if (db.version !== existing.version) {
      replaceAll(db)
      console.log(`[db] upgraded ${FILE} from schema v${existing.version} to v${db.version}`)
    }
    return db
  }
  const old = readOldJson()
  const db = old?.db ?? createSeed()
  replaceAll(db)
  if (old) {
    const now = Date.now()
    tx(() => {
      for (const [token, userId] of Object.entries(old.sessions)) {
        sql.prepare('INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), userId, now, now)
      }
    }, false)
    if (old.file === OLD_JSON) renameSync(OLD_JSON, `${OLD_JSON}.imported`)
    console.log(`[db] imported ${old.file} into ${FILE}`)
  }
  return db
})()
console.log(`[db] ${FILE}`)

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/* ------------------------------- Surface ------------------------------- */

export const store = {
  /** The current data. Treat as read-only; change it through the methods below. */
  get: (): Database => mem,
  /** Changes whenever the data does, including across restarts and new databases. */
  rev: () => `${instance}.${rev}`,

  /** Inserts or replaces one record. */
  put<C extends StoredCol>(col: C, rec: Database[C][number]) {
    if (col === 'shipments') rec = storedShipment(rec as Database['shipments'][number]) as Database[C][number]
    tx(() => writeRow(col, rec))
    const list = mem[col] as { id: string }[]
    const exists = list.some((r) => r.id === rec.id)
    const next = exists ? list.map((r) => (r.id === rec.id ? rec : r)) : col === 'shipments' ? [rec, ...list] : [...list, rec]
    mem = { ...mem, [col]: next }
  },

  remove(col: StoredCol, id: string) {
    tx(() => sql.prepare(`DELETE FROM ${col} WHERE id = ?`).run(id))
    mem = { ...mem, [col]: (mem[col] as { id: string }[]).filter((r) => r.id !== id) }
  },

  /** Read-modify-write of one shipment. Does nothing if it doesn't exist. */
  updateShipment(id: string, fn: (s: Database['shipments'][number]) => Database['shipments'][number]) {
    const s = mem.shipments.find((x) => x.id === id)
    if (s) store.put('shipments', fn(s))
  },

  set<K extends MetaKey>(key: K, value: Database[K]) {
    tx(() => setMeta(key, value))
    mem = { ...mem, [key]: value }
  },

  addLog(entry: IntegrationLog) {
    tx(() => {
      writeLog(entry)
      // Each kind is trimmed on its own, so frequent read-backs never push out the uploads.
      const isRead = "json_extract(data, '$.readBack') IS NOT NULL"
      sql.prepare(`DELETE FROM logs WHERE ${isRead} AND rowid NOT IN (SELECT rowid FROM logs WHERE ${isRead} ORDER BY rowid DESC LIMIT ${READ_LOG_LIMIT})`).run()
      sql.prepare(`DELETE FROM logs WHERE NOT ${isRead} AND rowid NOT IN (SELECT rowid FROM logs WHERE NOT ${isRead} ORDER BY rowid DESC LIMIT ${LOG_LIMIT})`).run()
    })
    mem = { ...mem, logs: trimLogs([entry, ...mem.logs]) }
  },

  /** Unit price and VAT type of RS.ge's products, by bar code (lower case). */
  productPrices: {
    all(): Map<string, { price: number; vatType: 0 | 1 | 2 }> {
      const rows = sql.prepare('SELECT bar_code, price, vat_type FROM product_prices').all() as { bar_code: string; price: number; vat_type: number }[]
      return new Map(rows.map((r) => [r.bar_code, { price: r.price, vatType: r.vat_type as 0 | 1 | 2 }]))
    },
    set(barCode: string, price: number, vatType: 0 | 1 | 2) {
      tx(() => sql.prepare('INSERT INTO product_prices VALUES (?, ?, ?) ON CONFLICT (bar_code) DO UPDATE SET price = excluded.price, vat_type = excluded.vat_type').run(barCode.toLowerCase(), price, vatType))
    },
    remove(barCodes: string[]) {
      if (!barCodes.length) return
      tx(() => {
        for (const b of barCodes) sql.prepare('DELETE FROM product_prices WHERE bar_code = ?').run(b.toLowerCase())
      })
    },
  },

  /** Removes the accounts older versions stored (now in .env). Called once .env's accounts were checked and work. */
  dropStoredAccounts() {
    const stale = (['rs', 'sms'] as const).filter((k) => ENV_ONLY[k].some((f) => getMeta<Record<string, unknown>>(k)?.[f] !== undefined))
    if (!stale.length) return
    tx(() => stale.forEach((k) => setMeta(k, mem[k])), false)
    console.log(`[db] removed the stored ${stale.join(' and ')} account (now in .env)`)
  },

  clearLogs() {
    tx(() => sql.exec('DELETE FROM logs'))
    mem = { ...mem, logs: [] }
  },

  sessions: {
    /** Starts a session and returns its token. Only a hash of the token is stored. */
    create(userId: string): string {
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      sql.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), userId, now, now)
      return token
    },
    /** The user id of a live session, or undefined. Expired sessions are removed. */
    get(token: string): string | undefined {
      if (!token) return undefined
      const h = hashToken(token)
      const row = sql.prepare('SELECT user_id, created_at, last_used_at FROM sessions WHERE token_hash = ?').get(h) as
        | { user_id: string; created_at: number; last_used_at: number }
        | undefined
      if (!row) return undefined
      const now = Date.now()
      if (now - row.last_used_at > SESSION_IDLE_MS || now - row.created_at > SESSION_MAX_MS) {
        sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h)
        return undefined
      }
      if (now - row.last_used_at > SESSION_TOUCH_MS) sql.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(now, h)
      return row.user_id
    },
    delete(token: string) {
      sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
    },
    /** Logs a user out everywhere, optionally keeping the session making the change. */
    deleteForUser(userId: string, keepToken?: string) {
      sql.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? hashToken(keepToken) : '')
    },
    purgeExpired() {
      const now = Date.now()
      sql.prepare('DELETE FROM sessions WHERE last_used_at < ? OR created_at < ?').run(now - SESSION_IDLE_MS, now - SESSION_MAX_MS)
    },
  },
}

store.sessions.purgeExpired()
setInterval(() => store.sessions.purgeExpired(), 6 * 3600_000).unref()
