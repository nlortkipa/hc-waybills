/**
 * HC Portal API server. Zero dependencies: Node's built-in http module.
 *
 *   node server/index.ts            (PORT, default 8787; HOST, default 0.0.0.0)
 *
 * RS.ge and smsoffice.ge accounts come from .env (server/config.ts). Before listening the server
 * checks that both services accept them, and exits if either is missing or doesn't work.
 *
 * Also serves the built web app from dist/ when it exists, so one process is
 * enough in production. The Android app talks to it over the network.
 *
 * Hosting (Vercel, Docker): the data is in PostgreSQL or MariaDB (DATABASE_URL), several processes may run at
 * once, and an idle one is stopped. GET /api/cron (with CRON_SECRET) runs the scheduled pass. See
 * DEPLOY.md.
 */
import './env.ts'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import type { User } from '../src/types.ts'
import { randomBytes } from 'node:crypto'
import { auth, checkServices, scheduledJobs, clearProducts, clearTrucks, HttpError, logs, pushPlates, readRsList, receiveWeight, REF_COLLECTIONS, refs, rsTinName, rsWaybills, shipments, viewFor, type RefCollection } from './logic.ts'
import { AUTO_CLOSE_MS, SCALE_CALLBACK_SECRET, SMS_TO_CONSOLE } from './config.ts'
import { rsCache } from './rscache.ts'
import { purgeExpired, store } from './store.ts'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const DIST = join(import.meta.dirname, '..', 'dist')

/**
 * The state revision clients poll with: the database's, plus what was read from RS.ge (memory only,
 * so it starts over with each process: BOOT keeps a new process from repeating an old revision).
 */
const BOOT = randomBytes(4).toString('base64url')
const stateRev = () => `${store.rev()}.${BOOT}.${rsCache.gen()}`

type Ctx = { req: IncomingMessage; body: any; params: string[]; user: User; token: string }
type Handler = (c: Ctx) => unknown

const routes: [method: string, path: RegExp, handler: Handler, isPublic?: boolean][] = [
  // The scheduled pass (Vercel Cron, or any scheduler), allowed with "Authorization: Bearer <CRON_SECRET>".
  [
    'GET',
    /^\/api\/cron$/,
    async ({ req }) => {
      const secret = process.env.CRON_SECRET?.trim()
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(404, 'Not found')
      await scheduledJobs()
      await purgeExpired()
    },
    true,
  ],
  // The scale posts the real weight of a weighed truck here (its SAP:API:URL:Output), signed: see receiveWeight.
  ['POST', /^\/api\/scale\/weight$/, ({ req, body }) => receiveWeight(req.headers.authorization, body), true],
  // Login: an SMS code to a known number, then the number and the code start a session.
  ['POST', /^\/api\/login\/code$/, ({ body }) => auth.sendCode(body?.phone), true],
  ['POST', /^\/api\/login$/, ({ body }) => auth.login(body?.phone, body?.code), true],
  ['POST', /^\/api\/logout$/, ({ token }) => auth.logout(token)],
  ['GET', /^\/api\/me$/, ({ user }) => user],
  [
    'GET',
    /^\/api\/state$/,
    // ?rev=R → 204 when nothing changed since R, so clients can poll cheaply. R is opaque and
    // survives restarts, so a client never mistakes new data for what it already has.
    // Someone is looking: RS.ge's data that is due is read again in the background.
    ({ req, user }) => {
      rsCache.touch()
      const since = new URL(req.url!, 'http://x').searchParams.get('rev')
      const rev = stateRev()
      if (since === rev) return NOT_MODIFIED
      return { rev, db: viewFor(user) }
    },
  ],
  ['PUT', /^\/api\/refs\/(\w+)$/, ({ params, body, user, token }) => refs.save(refCol(params[0]), body, user, token)],
  // A product's id is its bar code, which may hold any character: sent URL-encoded.
  ['DELETE', /^\/api\/refs\/(\w+)\/([^/]+)$/, ({ params, user }) => refs.remove(refCol(params[0]), decodeURIComponent(params[1]), user)],
  // Reads the product list / car-number list from RS.ge; the result arrives with the next state poll.
  ['POST', /^\/api\/products\/sync$/, ({ body, user }) => readRsList('products', body, user)],
  // Deletes every product, here and on RS.ge.
  ['POST', /^\/api\/products\/clear$/, ({ user }) => clearProducts(user)],
  // Deletes every truck, here and on RS.ge.
  ['POST', /^\/api\/trucks\/clear$/, ({ user }) => clearTrucks(user)],
  ['POST', /^\/api\/trucks\/sync$/, ({ body, user }) => readRsList('plates', body, user)],
  // Puts stored trucks' plates that RS.ge's car-number list lacks onto it.
  ['POST', /^\/api\/trucks\/push$/, ({ user }) => pushPlates(user)],
  ['GET', /^\/api\/rs\/name\/(\d+)$/, ({ params, user }) => rsTinName(params[0], user)],
  ['POST', /^\/api\/shipments$/, async ({ body, user }) => ({ id: await shipments.create(body ?? {}, user) })],
  // Edits a shipment: on RS.ge a draft is overwritten and an active waybill corrected.
  ['PUT', /^\/api\/shipments\/([\w-]+)$/, ({ params, body, user }) => shipments.edit(params[0], body ?? {}, user)],
  ['POST', /^\/api\/shipments\/([\w-]+)\/activate$/, ({ params, body, user }) => shipments.activate(params[0], body, user)],
  ['POST', /^\/api\/shipments\/([\w-]+)\/invoice$/, ({ params, user }) => shipments.invoice(params[0], user)],
  ['POST', /^\/api\/shipments\/([\w-]+)\/run$/, ({ params, user }) => void shipments.run(params[0], user).catch(() => {})],
  ['POST', /^\/api\/shipments\/([\w-]+)\/retry-sms$/, ({ params, user }) => void shipments.retrySms(params[0], user).catch(() => {})],
  // Sends the order to the scale again after it failed; the outcome arrives with the next state poll.
  ['POST', /^\/api\/shipments\/([\w-]+)\/retry-scale$/, ({ params, user }) => shipments.retryScale(params[0], user)],
  ['POST', /^\/api\/shipments\/([\w-]+)\/(close|cancel|delete)$/, ({ params, body, user }) => shipments.finish(params[0], params[1] as 'close' | 'cancel' | 'delete', user, body)],
  // Re-reads the waybill from RS.ge; the result arrives with the next state poll.
  ['POST', /^\/api\/shipments\/([\w-]+)\/rs-refresh$/, ({ params, user }) => shipments.refreshFromRs(params[0], user)],
  // Reads the waybills of the shipments a page shows ({ ids }) from RS.ge in the background.
  ['POST', /^\/api\/shipments\/rs-load$/, ({ body, user }) => shipments.loadFromRs(body, user)],
  // Asks smsoffice.ge whether the driver got the SMS; the result arrives with the next state poll.
  ['POST', /^\/api\/shipments\/([\w-]+)\/sms-refresh$/, ({ params, user }) => shipments.refreshSms(params[0], user)],
  ['DELETE', /^\/api\/logs$/, ({ user }) => logs.clear(user)],
  // The taxpayer's waybills on RS.ge (issued / received), whoever made them: ?side=&from=&to=
  [
    'GET',
    /^\/api\/rs\/waybills$/,
    ({ req, user }) => {
      const q = new URL(req.url!, 'http://x').searchParams
      return rsWaybills.list({ side: q.get('side') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined }, user)
    },
  ],
  ['GET', /^\/api\/rs\/waybills\/(\d+)$/, ({ params, user }) => rsWaybills.get(Number(params[0]), user)],
  ['POST', /^\/api\/rs\/waybills\/(\d+)\/(\w+)$/, ({ params, body, user }) => rsWaybills.act(Number(params[0]), params[1], body, user)],
]

const NOT_MODIFIED = Symbol('not-modified')

function refCol(c: string): RefCollection {
  if (!(REF_COLLECTIONS as readonly string[]).includes(c)) throw new HttpError(404, 'Unknown collection')
  return c as RefCollection
}

async function readBody(req: IncomingMessage) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1_000_000) throw new HttpError(413, 'Request too large')
  }
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

function send(res: ServerResponse, status: number, data?: unknown) {
  if (data === undefined) {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.apk': 'application/vnd.android.package-archive',
}

function serveStatic(pathname: string, res: ServerResponse) {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return send(res, 400, { error: 'Bad request' })
  }
  const path = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, path)
  if (!file.startsWith(DIST + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
  if (!existsSync(file)) return send(res, 404, { error: 'Not found' })
  // Built assets have hashed names and never change; everything else (index.html above all) is
  // checked on every load, so browsers and the Android app pick up a new build right away.
  const immutable = file.startsWith(join(DIST, 'assets') + sep)
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}

const server = createServer((req, res) => {
  // Nothing a request does may take the process down: answer 500 and carry on.
  handle(req, res).catch((e) => {
    console.error(e)
    if (!res.headersSent) send(res, 500, { error: 'სერვერის შეცდომა' })
    else res.destroy()
  })
})

async function handle(req: IncomingMessage, res: ServerResponse) {
  // The Android app runs on its own origin (http://localhost), so allow cross-origin calls.
  // Auth is a bearer token, not a cookie, so this does not expose sessions to other sites.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return send(res, 204)

  let path: string
  try {
    path = new URL(req.url!, 'http://x').pathname
  } catch {
    return send(res, 400, { error: 'Bad request' })
  }
  if (!path.startsWith('/api/')) return serveStatic(path, res)

  try {
    for (const [method, re, handler, isPublic] of routes) {
      const m = re.exec(path)
      if (!m || method !== req.method) continue
      // Another server process may have changed the data.
      await store.refresh()
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      const user = isPublic ? null : await auth.user(token)
      if (!user && !isPublic) throw new HttpError(401, 'სესია ამოიწურა — შედი თავიდან')
      const body = await readBody(req)
      const failures = store.failures()
      const out = await handler({ req, body, params: m.slice(1), user: user!, token })
      // Answered only once what it changed is stored.
      await store.flush(failures)
      if (out === NOT_MODIFIED) return send(res, 204)
      return send(res, 200, out ?? { ok: true })
    }
    send(res, 404, { error: 'Not found' })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    send(res, status, { error: status === 500 ? 'სერვერის შეცდომა' : (e as Error).message })
  }
}

// Background pipelines run detached from requests: log a stray rejection instead of exiting.
process.on('unhandledRejection', (e) => console.error('[api] unhandled rejection:', e))

// Stopped (Vercel stops an idle server, Docker on `docker stop`): store what is queued, then exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close()
    void store
      .close()
      .catch((e) => console.error('[db] closing:', e))
      .finally(() => process.exit(0))
  })
}

// Both services must work before anything is served.
console.log('[api] checking RS.ge and SMS…')
const problems = await checkServices()
if (problems.length) {
  console.error(`[api] not starting — fix .env (see .env.example) and start again:\n${problems.map((p) => `  • ${p}`).join('\n')}`)
  process.exit(1)
}

server.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`)
  const m = AUTO_CLOSE_MS === null ? null : AUTO_CLOSE_MS / 60_000
  console.log(
    m === null
      ? '[api] waybills are not completed automatically (WAYBILL_AUTO_CLOSE)'
      : m
        ? `[api] active waybills are completed ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} after transport starts`
        : '[api] active waybills are completed as soon as transport starts',
  )
  if (!SCALE_CALLBACK_SECRET) console.warn('[api] SCALE_CALLBACK_* not set: the scale cannot report real weights to /api/scale/weight')
  if (SMS_TO_CONSOLE) console.warn('[api] LOGIN_CODES=console: every SMS (login codes, waybill SMS to drivers) is printed here, not texted — for testing only')
  shipments.resumeAll()
})
