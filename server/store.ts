/**
 * The database: SQLite through Node's built-in node:sqlite (no dependencies).
 *
 * Each record is one row holding its JSON, so a change writes only the rows it touches,
 * inside a transaction. A copy of the data is kept in memory for fast reads; every write
 * goes to SQLite first and reaches the copy only after it committed.
 *
 * On first start an existing db.json (the previous storage) is imported and renamed to
 * db.json.imported. The RS.ge password is stored encrypted (server/secret.ts); the file is
 * still readable by its owner only.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Database, IntegrationLog, RsSettings } from '../src/types.ts'
import { decrypt, encrypt, isEncrypted } from './secret.ts'
import { createSeed, migrate } from './seed.ts'

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

type RecordCol = 'carriers' | 'drivers' | 'trucks' | 'users'
export type StoredCol = RecordCol | 'shipments'
type MetaKey = 'cargo' | 'rs'

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
  CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS trucks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, carrier_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS shipments_created ON shipments (created_at);
  CREATE INDEX IF NOT EXISTS shipments_carrier ON shipments (carrier_id);
  CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, at TEXT NOT NULL, shipment_id TEXT, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
`)

/* ------------------------------ Low level ------------------------------ */

const RECORD_COLS: RecordCol[] = ['carriers', 'drivers', 'trucks', 'users']

function getMeta<T>(key: string): T | undefined {
  const row = sql.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as T) : undefined
}
const setMetaStmt = sql.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
const setMeta = (key: string, value: unknown) => setMetaStmt.run(key, JSON.stringify(key === 'rs' ? sealRs(value as RsSettings) : value))

/* The RS.ge password is encrypted in the database and plain only in memory. */
const sealRs = (rs: RsSettings): RsSettings => ({ ...rs, sp: encrypt(rs.sp ?? '') })
function openRs(rs: RsSettings): RsSettings {
  if (!rs?.sp) return rs
  try {
    return { ...rs, sp: decrypt(rs.sp) }
  } catch {
    // Wrong or lost HC_SECRET_KEY: the password is unreadable. Treat RS.ge as disconnected
    // (the admin enters it again) instead of refusing to start.
    console.error('[secret] the stored RS.ge password can\'t be decrypted with HC_SECRET_KEY — reconnect RS.ge in settings')
    return { ...rs, sp: '' }
  }
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

function readAll(): Database | null {
  const version = getMeta<number>('version')
  if (version == null) return null
  return {
    version,
    carriers: parseRows(sql.prepare('SELECT data FROM carriers ORDER BY rowid').all()),
    drivers: parseRows(sql.prepare('SELECT data FROM drivers ORDER BY rowid').all()),
    trucks: parseRows(sql.prepare('SELECT data FROM trucks ORDER BY rowid').all()),
    users: parseRows(sql.prepare('SELECT data FROM users ORDER BY rowid').all()),
    shipments: parseRows(sql.prepare('SELECT data FROM shipments ORDER BY created_at DESC, rowid DESC').all()),
    logs: trimLogs(parseRows(sql.prepare('SELECT data FROM logs ORDER BY rowid DESC').all())),
    cargo: getMeta('cargo')!,
    rs: openRs(getMeta('rs')!),
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
    for (const col of RECORD_COLS) for (const r of db[col]) writeRow(col, r)
    for (const s of db.shipments) writeRow('shipments', s)
    for (const l of trimLogs(db.logs).reverse()) writeLog(l)
    setMeta('version', db.version)
    sql.prepare("DELETE FROM meta WHERE key = 'settings'").run()
    setMeta('cargo', db.cargo)
    setMeta('rs', db.rs)
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

// A password stored before encryption existed: encrypt it now.
{
  const sp = getMeta<RsSettings>('rs')?.sp
  if (sp && !isEncrypted(sp)) {
    tx(() => setMeta('rs', mem.rs), false)
    console.log('[secret] encrypted the stored RS.ge password')
  }
}

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
