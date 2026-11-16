/**
 * The database: one JSON document kept in memory and written to disk after every
 * change (atomically, via a temp file). Plenty for a few carriers and operators;
 * swap for a real database engine behind the same get/update surface when needed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createSeed, migrate } from './seed.ts'
import type { Database } from '../src/types.ts'

const FILE = process.env.HC_DB_FILE ?? join(import.meta.dirname, 'data', 'db.json')

interface Stored {
  db: Database
  /** token → user id */
  sessions: Record<string, string>
}

/** Data entered before the server existed, shared between browsers by the old dev setup. */
const LEGACY = join(import.meta.dirname, '..', '.mockdb', 'db.json')

function load(): Stored {
  try {
    if (!existsSync(FILE) && existsSync(LEGACY)) {
      const legacy = JSON.parse(readFileSync(LEGACY, 'utf8')) as Database
      const db = migrate(legacy)
      if (db) {
        console.log(`[db] imported existing data from ${LEGACY}`)
        return { db, sessions: {} }
      }
    }
    if (existsSync(FILE)) {
      const s = JSON.parse(readFileSync(FILE, 'utf8')) as Stored
      const db = s.db && migrate(s.db)
      if (db) {
        if (db.version !== s.db.version) console.log(`[db] upgraded ${FILE} from schema v${s.db.version} to v${db.version}`)
        return { db, sessions: s.sessions ?? {} }
      }
      console.warn(`[db] ${FILE} has schema v${s.db?.version}, which can't be upgraded — starting fresh`)
    }
  } catch (e) {
    console.error(`[db] could not read ${FILE}:`, e)
  }
  return { db: createSeed(), sessions: {} }
}

let stored = load()
/** Bumped on every change so clients can cheaply ask "anything new?". */
let rev = 1

function save() {
  mkdirSync(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(stored))
  renameSync(tmp, FILE)
}
save()
console.log(`[db] ${FILE}`)

export const store = {
  get: () => stored.db,
  rev: () => rev,
  update(fn: (d: Database) => Database) {
    stored.db = fn(stored.db)
    rev++
    save()
  },
  reset() {
    stored = { db: createSeed(), sessions: stored.sessions }
    rev++
    save()
  },
  sessions: {
    get: (token: string) => stored.sessions[token],
    set(token: string, userId: string) {
      stored.sessions[token] = userId
      save()
    },
    delete(token: string) {
      delete stored.sessions[token]
      save()
    },
  },
}
