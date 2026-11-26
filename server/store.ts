/**
 * The database: PostgreSQL when DATABASE_URL is set (hosting), otherwise a SQLite file (server/db.ts).
 *
 * Only what RS.ge doesn't have is stored. RS.ge's data (products, car numbers, waybills, the seller)
 * is read from RS.ge on demand and kept in memory (server/rscache.ts). A product's unit price and VAT
 * type are shown on RS.ge's portal but its API doesn't carry them, so they are stored here by bar code.
 *
 * Each record is one row holding its JSON. A copy of the data is kept in memory: reads are instant
 * and the business rules (server/logic.ts) stay synchronous. A change reaches the copy at once and is
 * written to the database in order, each one in a transaction; every request waits for the writes
 * before it answers (`flush`), so what a client is told has been stored.
 *
 * Several server processes may share the database (e.g. Vercel starts more than one under load).
 * Every write counts up the revision in the database. Before a request is handled (`refresh`), the
 * copy is read again when the database's revision isn't the one this process last wrote or read.
 *
 * On first start an existing db.json (the storage before SQLite) is imported and renamed to
 * db.json.imported. The RS.ge service user and the SMS account are not stored: they come from .env
 * (server/config.ts).
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RS_LIVE_FIELDS, type IntegrationLog, type RsSettings, type SmsSettings, type StoredDatabase as Database } from '../src/types.ts'
import { defaultSmsSettings } from '../src/lib/sms.ts'
import { defaultRsSettings } from '../src/lib/rs.ts'
import { openSql, type Query } from './db.ts'
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
type Prices = Map<string, { price: number; vatType: 0 | 1 | 2 }>

// The container sets HC_REQUIRE_DATABASE_URL: its own disk is thrown away, so a file there would lose the data.
if (process.env.HC_REQUIRE_DATABASE_URL && !process.env.DATABASE_URL?.trim()) {
  console.error('[db] DATABASE_URL is not set: connect a PostgreSQL database (see DEPLOY.md)')
  process.exit(1)
}
const sql = await openSql(undefined, FILE)

/* ------------------------------ Low level ------------------------------ */

const RECORD_COLS: RecordCol[] = ['carriers', 'routes', 'drivers', 'trucks', 'users']

const setMeta = (q: Query, key: string, value: unknown) =>
  q.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(seal(key, value))])

/* The services' accounts live in .env (server/config.ts). Older versions stored them here: never written again. */
const ENV_ONLY: Record<MetaKey, string[]> = { rs: ['su', 'sp'], sms: ['apiKey', 'sender'] }
const omit = <T,>(value: T, keys: readonly string[]): T => (value ? (Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T) : value)
function seal(key: string, value: unknown) {
  // What RS.ge says about the account is never stored: it is read again from RS.ge.
  if (key === 'rs') value = omit(value, RS_LIVE_FIELDS)
  return key in ENV_ONLY ? omit(value, ENV_ONLY[key as MetaKey]) : value
}

function writeRow(q: Query, col: StoredCol, rec: { id: string }) {
  if (col === 'shipments') {
    const s = rec as Database['shipments'][number]
    return q.run(
      'INSERT INTO shipments (id, carrier_id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET carrier_id = excluded.carrier_id, data = excluded.data',
      [s.id, s.carrierId, s.createdAt, JSON.stringify(s)],
    )
  }
  return q.run(`INSERT INTO ${col} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`, [rec.id, JSON.stringify(rec)])
}

const writeLog = (q: Query, l: IntegrationLog) =>
  q.run('INSERT INTO logs (id, at, shipment_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, shipment_id = excluded.shipment_id, data = excluded.data', [
    l.id,
    l.at,
    l.shipmentId ?? null,
    JSON.stringify(l),
  ])

const parseRows = <T,>(rows: unknown[]) => (rows as { data: string }[]).map((r) => JSON.parse(r.data) as T)
const selectData = (q: Query, table: string, order = `${sql.seq}`) => q.all(`SELECT data FROM ${table} ORDER BY ${order}`)

interface Loaded {
  db: Database
  prices: Prices
  instance: string
  /** Revision of the database when it was read. */
  rev: number
  /** Log rows beyond what is kept (older versions, or another process's trimming). */
  extraLogs: string[]
  /** Accounts older versions stored in the database (now in .env). */
  staleAccounts: MetaKey[]
}

/** Everything, as stored. null: an empty database. The revision is read first, so it is never newer than the data. */
async function readAll(): Promise<Loaded | null> {
  const meta = new Map((await sql.all<{ key: string; value: string }>('SELECT key, value FROM meta')).map((r) => [r.key, JSON.parse(r.value) as unknown]))
  const version = meta.get('version') as number | undefined
  if (version == null) return null
  const rev = Number(meta.get('rev') ?? 0)
  const logs = parseRows<IntegrationLog>(await selectData(sql, 'logs', `${sql.seq} DESC`))
  const kept = trimLogs(logs)
  const keep = new Set(kept.map((l) => l.id))
  const raw = (k: MetaKey) => meta.get(k) as Record<string, unknown> | undefined
  const priceRows = await sql.all<{ bar_code: string; price: number; vat_type: number }>('SELECT bar_code, price, vat_type FROM product_prices')
  const db: Database = {
    version,
    carriers: parseRows(await selectData(sql, 'carriers')),
    routes: parseRows(await selectData(sql, 'routes')),
    drivers: parseRows(await selectData(sql, 'drivers')),
    trucks: parseRows(await selectData(sql, 'trucks')),
    users: parseRows(await selectData(sql, 'users')),
    shipments: parseRows(await selectData(sql, 'shipments', `created_at DESC, ${sql.seq} DESC`)),
    logs: kept,
    // Before v19: the one admin-set cargo, which migrate() turns into a product.
    ...(version < 19 && { cargo: meta.get('cargo') as never }),
    // Before v24 products were stored; migrate() reads them to point route lines at their bar codes.
    ...(version < 24 && { products: (await sql.tableExists('products')) ? parseRows(await selectData(sql, 'products')) : [] }),
    rs: { ...defaultRsSettings(), ...omit(raw('rs') as RsSettings | undefined, ENV_ONLY.rs) },
    // Missing before v17 (migrate() adds it); defaults also cover a v17 file written without it.
    sms: { ...defaultSmsSettings(), ...omit(raw('sms') as SmsSettings | undefined, ENV_ONLY.sms) },
  }
  return {
    db,
    prices: new Map(priceRows.map((r) => [r.bar_code, { price: Number(r.price), vatType: r.vat_type as 0 | 1 | 2 }])),
    instance: (meta.get('instance') as string | undefined) ?? '',
    rev,
    extraLogs: logs.filter((l) => !keep.has(l.id)).map((l) => l.id),
    staleAccounts: (['rs', 'sms'] as const).filter((k) => ENV_ONLY[k].some((f) => raw(k)?.[f] !== undefined)),
  }
}

/* ------------------------------ Writing ------------------------------ */

/** Revision of the data in memory: the database's when it was last read or written here. */
let rev = 0
/** New for every database (a deleted one starts over at a new id, not at an old revision). */
let instance = ''
/** The copy in memory may be behind the database: read it again before the next request. */
let stale = false
let pending: Promise<void> = Promise.resolve()
/** Writes queued so far, and how many failed: a request that saw a failure answers with an error. */
let queued = 0
let failures = 0

/**
 * Queues `fn` to run in one transaction after the writes before it, and counts up the revision
 * (unless `bump` is false: nothing a client is shown changed). A failure is logged and the copy in
 * memory is read again from the database before the next request.
 */
function write(fn: (q: Query) => Promise<unknown>, bump = true) {
  queued++
  pending = pending.then(() =>
    sql
      .tx(async (q) => {
        await fn(q)
        if (!bump) return
        const [row] = await q.all<{ value: string }>("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev' RETURNING value")
        const next = Number(row.value)
        // Another process wrote in between: its change isn't in memory here yet.
        if (next !== rev + 1) stale = true
        rev = next
      })
      .catch((e) => {
        failures++
        stale = true
        console.error('[db] a write failed; the data is read again from the database:', e)
      }),
  )
}

function replaceAll(db: Database) {
  write(async (q) => {
    for (const t of [...RECORD_COLS, 'shipments', 'logs']) await q.run(`DELETE FROM ${t}`)
    // Products are RS.ge's only since v24.
    await q.run('DROP TABLE IF EXISTS products')
    for (const col of RECORD_COLS) for (const r of db[col]) await writeRow(q, col, r)
    for (const s of db.shipments) await writeRow(q, 'shipments', storedShipment(s))
    for (const l of trimLogs(db.logs).reverse()) await writeLog(q, l)
    await setMeta(q, 'version', db.version)
    await q.run("DELETE FROM meta WHERE key IN ('settings', 'cargo')")
    await setMeta(q, 'rs', db.rs)
    await setMeta(q, 'sms', db.sms)
    if (!instance) await setMeta(q, 'instance', (instance = randomBytes(6).toString('base64url')))
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

let mem: Database
let prices: Prices = new Map()
let staleAccounts: MetaKey[] = []

/** Takes what was read as the copy in memory. False when its schema is newer than this code knows. */
function adopt(l: Loaded): boolean {
  const db = migrate(l.db)
  if (!db) return false
  mem = db
  prices = l.prices
  instance = l.instance
  rev = l.rev
  staleAccounts = l.staleAccounts
  return true
}

{
  const existing = await readAll()
  if (existing) {
    // Never silently start over on top of real data: stop and let a person look.
    if (!adopt(existing)) throw new Error(`[db] ${sql.where} has schema v${existing.db.version}, which can't be upgraded`)
    if (mem!.version !== existing.db.version) {
      replaceAll(mem!)
      console.log(`[db] upgraded ${sql.where} from schema v${existing.db.version} to v${mem!.version}`)
    } else if (existing.extraLogs.length) {
      write(async (q) => {
        for (const id of existing.extraLogs) await q.run('DELETE FROM logs WHERE id = ?', [id])
      }, false)
    }
  } else {
    // Only a local SQLite file has an older JSON file next to it.
    const old = sql.kind === 'sqlite' ? readOldJson() : null
    mem = old?.db ?? createSeed()
    rev = Number((await sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'rev'"))[0]?.value ?? 0)
    replaceAll(mem)
    if (old) {
      const now = Date.now()
      write(async (q) => {
        for (const [token, userId] of Object.entries(old.sessions)) {
          await q.run('INSERT INTO sessions VALUES (?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING', [hashToken(token), userId, now, now])
        }
      }, false)
      if (old.file === OLD_JSON) renameSync(OLD_JSON, `${OLD_JSON}.imported`)
      console.log(`[db] imported ${old.file} into ${sql.where}`)
    }
  }
  await pending
  if (failures) throw new Error(`[db] could not write to ${sql.where}`)
  console.log(`[db] ${sql.where}`)
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

let refreshing: Promise<void> | null = null

async function reloadIfChanged() {
  // A few tries: a write made here while reading means what was read may lack it.
  for (let i = 0; i < 3; i++) {
    await pending
    const [row] = await sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'rev'")
    if (!stale && Number(row?.value) === rev) return
    const before = queued
    const l = await readAll()
    if (queued !== before) continue
    if (!l) return
    if (!adopt(l)) {
      console.error(`[db] the database has schema v${l.db.version}, newer than this server: an update is being deployed`)
      return
    }
    stale = false
    return
  }
}

/* ------------------------------- Surface ------------------------------- */

export const store = {
  /** Which database: 'postgres' or 'sqlite'. */
  kind: sql.kind,
  /** The current data. Treat as read-only; change it through the methods below. */
  get: (): Database => mem,
  /** Changes whenever the data does, including across restarts and new databases. */
  rev: () => `${instance}.${rev}`,

  /** Reads the data again if another process changed it. Called before each request is handled. */
  refresh(): Promise<void> {
    refreshing ??= reloadIfChanged().finally(() => (refreshing = null))
    return refreshing
  },

  /** Waits until every change made so far is in the database. Throws if one of them failed since `since`. */
  async flush(since = failures) {
    await pending
    if (failures !== since) throw new Error('[db] a change could not be stored')
  },
  /** Failures so far, to pass to flush(). */
  failures: () => failures,

  /** Inserts or replaces one record. */
  put<C extends StoredCol>(col: C, rec: Database[C][number]) {
    if (col === 'shipments') rec = storedShipment(rec as Database['shipments'][number]) as Database[C][number]
    write((q) => writeRow(q, col, rec))
    const list = mem[col] as { id: string }[]
    const exists = list.some((r) => r.id === rec.id)
    const next = exists ? list.map((r) => (r.id === rec.id ? rec : r)) : col === 'shipments' ? [rec, ...list] : [...list, rec]
    mem = { ...mem, [col]: next }
  },

  remove(col: StoredCol, id: string) {
    write((q) => q.run(`DELETE FROM ${col} WHERE id = ?`, [id]))
    mem = { ...mem, [col]: (mem[col] as { id: string }[]).filter((r) => r.id !== id) }
  },

  /** Read-modify-write of one shipment. Does nothing if it doesn't exist. */
  updateShipment(id: string, fn: (s: Database['shipments'][number]) => Database['shipments'][number]) {
    const s = mem.shipments.find((x) => x.id === id)
    if (s) store.put('shipments', fn(s))
  },

  set<K extends MetaKey>(key: K, value: Database[K]) {
    write((q) => setMeta(q, key, value))
    mem = { ...mem, [key]: value }
  },

  addLog(entry: IntegrationLog) {
    // Each kind is trimmed on its own, so frequent read-backs never push out the uploads.
    const all = [entry, ...mem.logs]
    const kept = trimLogs(all)
    const keep = new Set(kept.map((l) => l.id))
    const dropped = all.filter((l) => !keep.has(l.id)).map((l) => l.id)
    write(async (q) => {
      await writeLog(q, entry)
      for (const id of dropped) await q.run('DELETE FROM logs WHERE id = ?', [id])
    })
    mem = { ...mem, logs: kept }
  },

  /** Unit price and VAT type of RS.ge's products, by bar code (lower case). */
  productPrices: {
    all: (): Prices => prices,
    set(barCode: string, price: number, vatType: 0 | 1 | 2) {
      const key = barCode.toLowerCase()
      write((q) => q.run('INSERT INTO product_prices VALUES (?, ?, ?) ON CONFLICT (bar_code) DO UPDATE SET price = excluded.price, vat_type = excluded.vat_type', [key, price, vatType]))
      prices = new Map(prices).set(key, { price, vatType })
    },
    remove(barCodes: string[]) {
      if (!barCodes.length) return
      const keys = barCodes.map((b) => b.toLowerCase())
      write(async (q) => {
        for (const b of keys) await q.run('DELETE FROM product_prices WHERE bar_code = ?', [b])
      })
      prices = new Map(prices)
      for (const b of keys) prices.delete(b)
    },
  },

  /** Removes the accounts older versions stored (now in .env). Called once .env's accounts were checked and work. */
  dropStoredAccounts() {
    if (!staleAccounts.length) return
    const keys = staleAccounts
    staleAccounts = []
    write(async (q) => {
      for (const k of keys) await setMeta(q, k, mem[k])
    }, false)
    console.log(`[db] removed the stored ${keys.join(' and ')} account (now in .env)`)
  },

  clearLogs() {
    write((q) => q.run('DELETE FROM logs'))
    mem = { ...mem, logs: [] }
  },

  sessions: {
    /** Starts a session and returns its token. Only a hash of the token is stored. */
    async create(userId: string): Promise<string> {
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      await sql.run('INSERT INTO sessions VALUES (?, ?, ?, ?)', [hashToken(token), userId, now, now])
      return token
    },
    /** The user id of a live session, or undefined. Expired sessions are removed. */
    async get(token: string): Promise<string | undefined> {
      if (!token) return undefined
      const h = hashToken(token)
      const [row] = await sql.all<{ user_id: string; created_at: number; last_used_at: number }>(
        'SELECT user_id, created_at, last_used_at FROM sessions WHERE token_hash = ?',
        [h],
      )
      if (!row) return undefined
      const now = Date.now()
      if (now - Number(row.last_used_at) > SESSION_IDLE_MS || now - Number(row.created_at) > SESSION_MAX_MS) {
        await sql.run('DELETE FROM sessions WHERE token_hash = ?', [h])
        return undefined
      }
      if (now - Number(row.last_used_at) > SESSION_TOUCH_MS) await sql.run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', [now, h])
      return row.user_id
    },
    delete(token: string) {
      write((q) => q.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]), false)
    },
    /** Logs a user out everywhere, optionally keeping the session making the change. */
    deleteForUser(userId: string, keepToken?: string) {
      write((q) => q.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, keepToken ? hashToken(keepToken) : '']), false)
    },
    async purgeExpired() {
      const now = Date.now()
      await sql.run('DELETE FROM sessions WHERE last_used_at < ? OR created_at < ?', [now - SESSION_IDLE_MS, now - SESSION_MAX_MS])
    },
  },

  /** Short-lived values by key (login codes), shared by every server process. */
  temp: {
    async get<T>(key: string): Promise<T | undefined> {
      const [row] = await sql.all<{ data: string; expires: number }>('SELECT data, expires FROM login_codes WHERE key = ?', [key])
      return row && Number(row.expires) > Date.now() ? (JSON.parse(row.data) as T) : undefined
    },
    /** Kept until `keepUntil` (ms). */
    async set(key: string, value: unknown, keepUntil: number) {
      await sql.run('INSERT INTO login_codes (key, data, expires) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data, expires = excluded.expires', [
        key,
        JSON.stringify(value),
        keepUntil,
      ])
    },
    async purgeExpired() {
      await sql.run('DELETE FROM login_codes WHERE expires < ?', [Date.now()])
    },
  },

  /**
   * Claims on shipments, so two server processes never work on the same one at once (one could
   * otherwise upload a waybill or text a driver the other is already handling).
   */
  locks: {
    /** Claims `id` for `holder` for `ms`, unless another holder has a live claim. True when claimed. */
    async claim(id: string, holder: string, ms: number): Promise<boolean> {
      const now = Date.now()
      const rows = await sql.all(
        'INSERT INTO locks (id, holder, expires) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires = excluded.expires WHERE locks.expires < ? OR locks.holder = ? RETURNING id',
        [id, holder, now + ms, now, holder],
      )
      return rows.length > 0
    },
    async release(id: string, holder: string) {
      await sql.run('DELETE FROM locks WHERE id = ? AND holder = ?', [id, holder])
    },
    /** Shipments another holder has a live claim on. */
    async heldByOthers(holder: string): Promise<Set<string>> {
      const rows = await sql.all<{ id: string }>('SELECT id FROM locks WHERE expires >= ? AND holder != ?', [Date.now(), holder])
      return new Set(rows.map((r) => r.id))
    },
    async purgeExpired() {
      await sql.run('DELETE FROM locks WHERE expires < ?', [Date.now()])
    },
  },

  /** Writes what is queued and closes the database (on shutdown). */
  async close() {
    await pending
    await sql.close()
  },
}

/** Removes expired sessions, login codes and claims. Runs at start, every 6 hours, and from /api/cron. */
export async function purgeExpired() {
  await Promise.all([store.sessions.purgeExpired(), store.temp.purgeExpired(), store.locks.purgeExpired()]).catch((e) => console.error('[db] purge failed:', e))
}

void purgeExpired()
setInterval(() => void purgeExpired(), 6 * 3600_000).unref()
