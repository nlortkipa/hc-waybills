/**
 * Copies a local SQLite database (default server/data/hc.db) into the PostgreSQL database at
 * DATABASE_URL, e.g. the one a Vercel project uses. Everything is copied: records, logs, sessions
 * (logged-in users stay logged in) and product prices.
 *
 *   DATABASE_URL='postgres://…' npm run db:import [-- path/to/hc.db] [--replace]
 *
 * Refuses when the target already holds data, unless --replace (which deletes it first). Stop the
 * server using the SQLite file first, or copy it with `sqlite3 hc.db ".backup copy.db"`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSql } from '../server/db.ts'

const args = process.argv.slice(2)
const replace = args.includes('--replace')
const file = args.find((a) => !a.startsWith('--')) ?? join(import.meta.dirname, '..', 'server', 'data', 'hc.db')
const url = process.env.DATABASE_URL?.trim()

if (!url) {
  console.error('Set DATABASE_URL to the PostgreSQL database to copy into.')
  process.exit(1)
}
if (!existsSync(file)) {
  console.error(`${file} does not exist.`)
  process.exit(1)
}

/** In this order; each table's rows in the order they were added. */
const TABLES = ['meta', 'carriers', 'routes', 'drivers', 'trucks', 'users', 'shipments', 'logs', 'sessions', 'product_prices']
const KEYS: Record<string, string> = { meta: 'key', sessions: 'token_hash', product_prices: 'bar_code' }

const src = new DatabaseSync(file, { readOnly: true })
const has = (t: string) => !!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
if (!src.prepare("SELECT 1 FROM meta WHERE key = 'version'").get()) {
  console.error(`${file} holds no data.`)
  process.exit(1)
}

const pg = await openSql(url)
if (pg.kind !== 'postgres') throw new Error('DATABASE_URL is not a PostgreSQL database')
const [existing] = await pg.all("SELECT value FROM meta WHERE key = 'version'")
if (existing && !replace) {
  console.error(`${pg.where} already holds data (schema v${existing.value}). Run again with --replace to overwrite it.`)
  await pg.close()
  process.exit(1)
}

await pg.tx(async (q) => {
  for (const t of [...TABLES, 'login_codes', 'locks']) await q.run(`DELETE FROM ${t}`)
  for (const t of TABLES) {
    if (!has(t)) continue
    const rows = src.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[]
    for (const row of rows) {
      const cols = Object.keys(row)
      const key = KEYS[t] ?? 'id'
      await q.run(
        `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (${key}) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
        cols.map((c) => row[c]),
      )
    }
    console.log(`${t}: ${rows.length}`)
  }
  // Clients poll with the revision: start above anything they may have seen.
  await q.run("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev'")
})
await pg.close()
console.log(`Copied ${file} into ${pg.where}.`)
