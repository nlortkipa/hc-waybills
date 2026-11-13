// Read-only HTTP API over the Scale Service database, used by the website's
// "სასწორის ბაზა" page. Connects as the `inspector` login (db_datareader), so
// it cannot change data even if a query were crafted to try.
//
//   GET /api/status                       scale API + database reachability
//   GET /api/tables                       every user table with row counts
//   GET /api/tables/:schema/:table?limit&offset&sort&dir&q
import http from 'node:http'
import sql from 'mssql'

const PORT = Number(process.env.PORT ?? 8080)
const SCALE_API_URL = process.env.SCALE_API_URL ?? 'http://scale-api:8080'
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*'
const DB_NAME = process.env.DB_NAME

const config = {
  server: process.env.DB_HOST ?? 'scale-db',
  port: Number(process.env.DB_PORT ?? 1433),
  database: DB_NAME,
  user: process.env.DB_USER ?? 'inspector',
  password: process.env.DB_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 4 },
  requestTimeout: 15000,
}

let poolPromise = null
function pool() {
  poolPromise ??= sql.connect(config).catch((err) => {
    poolPromise = null
    throw err
  })
  return poolPromise
}

const quote = (id) => `[${String(id).replaceAll(']', ']]')}]`

async function apiStatus() {
  const started = Date.now()
  try {
    const ctrl = AbortSignal.timeout(3000)
    const res = await fetch(`${SCALE_API_URL}/swagger/v1/swagger.json`, { signal: ctrl })
    // Any HTTP answer means Kestrel is up; Swagger may be disabled outside Development.
    return { up: true, status: res.status, swagger: res.ok, ms: Date.now() - started }
  } catch (err) {
    return { up: false, error: err.cause?.code ?? err.cause?.errors?.[0]?.code ?? err.message }
  }
}

async function dbStatus() {
  try {
    const p = await pool()
    const r = await p.request().query('SELECT DB_NAME() AS name, @@VERSION AS version')
    return { up: true, name: r.recordset[0].name, version: r.recordset[0].version.split('\n')[0].trim() }
  } catch (err) {
    return { up: false, error: err.message }
  }
}

async function listTables() {
  const p = await pool()
  const r = await p.request().query(`
    SELECT s.name AS [schema], t.name AS name,
           SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.rows ELSE 0 END) AS rows,
           (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = t.object_id) AS columns
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    LEFT JOIN sys.partitions ps ON ps.object_id = t.object_id
    WHERE t.is_ms_shipped = 0
    GROUP BY s.name, t.name, t.object_id
    ORDER BY s.name, t.name`)
  return r.recordset.map((t) => ({ ...t, rows: Number(t.rows ?? 0) }))
}

const TEXT_TYPES = new Set(['char', 'nchar', 'varchar', 'nvarchar', 'text', 'ntext', 'uniqueidentifier'])

async function tableColumns(p, schema, table) {
  const r = await p
    .request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT c.name, ty.name AS type, c.max_length AS maxLength, c.is_nullable AS nullable, c.is_identity AS [identity],
             CASE WHEN ic.column_id IS NULL THEN 0 ELSE 1 END AS pk
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
      LEFT JOIN sys.index_columns ic ON ic.object_id = t.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id
      WHERE s.name = @schema AND t.name = @table
      ORDER BY c.column_id`)
  return r.recordset.map((c) => ({ ...c, nullable: !!c.nullable, identity: !!c.identity, pk: !!c.pk }))
}

function cell(v) {
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v.length <= 32 ? `0x${v.toString('hex').toUpperCase()}` : `<binary ${v.length} bytes>`
  if (typeof v === 'bigint') return v.toString()
  return v
}

async function readTable(schema, table, params) {
  const p = await pool()
  const columns = await tableColumns(p, schema, table)
  if (columns.length === 0) return null

  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 500)
  const offset = Math.max(Number(params.get('offset')) || 0, 0)
  const sortCol = columns.find((c) => c.name === params.get('sort'))
  const dir = params.get('dir') === 'desc' ? 'DESC' : 'ASC'
  const q = (params.get('q') ?? '').trim()

  const order = sortCol
    ? `${quote(sortCol.name)} ${dir}`
    : columns.some((c) => c.pk)
      ? columns.filter((c) => c.pk).map((c) => `${quote(c.name)} DESC`).join(', ')
      : '(SELECT NULL)'

  const searchable = columns.filter((c) => TEXT_TYPES.has(c.type) || ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money'].includes(c.type))
  const where = q && searchable.length ? `WHERE ${searchable.map((c) => `CAST(${quote(c.name)} AS nvarchar(4000)) LIKE @q`).join(' OR ')}` : ''
  const from = `${quote(schema)}.${quote(table)}`

  const req = () => p.request().input('q', sql.NVarChar, `%${q.replace(/[[%_]/g, '[$&]')}%`)
  const [count, data] = await Promise.all([
    req().query(`SELECT COUNT_BIG(*) AS total FROM ${from} ${where}`),
    req()
      .input('offset', sql.Int, offset)
      .input('limit', sql.Int, limit)
      .query(`SELECT * FROM ${from} ${where} ORDER BY ${order} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`),
  ])

  const rows = data.recordset.map((r) => Object.fromEntries(columns.map((c) => [c.name, cell(r[c.name])])))
  return { schema, table, columns, rows, total: Number(count.recordset[0].total), limit, offset }
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': ALLOW_ORIGIN, 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' })
      return res.end()
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Read-only' })
    try {
      if (url.pathname === '/api/status') {
        const [api, db] = await Promise.all([apiStatus(), dbStatus()])
        return send(res, 200, { api, db })
      }
      if (url.pathname === '/api/tables') return send(res, 200, await listTables())
      const m = url.pathname.match(/^\/api\/tables\/([^/]+)\/([^/]+)$/)
      if (m) {
        const data = await readTable(decodeURIComponent(m[1]), decodeURIComponent(m[2]), url.searchParams)
        return data ? send(res, 200, data) : send(res, 404, { error: 'Table not found' })
      }
      send(res, 404, { error: 'Not found' })
    } catch (err) {
      console.error(err)
      send(res, 503, { error: err.message })
    }
  })
  .listen(PORT, () => console.log(`scale-inspector listening on :${PORT} (db ${config.server}/${DB_NAME})`))
