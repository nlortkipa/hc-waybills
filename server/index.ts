/**
 * HC Portal API server. Zero dependencies: Node's built-in http module.
 *
 *   node server/index.ts            (PORT, default 8787; HOST, default 0.0.0.0)
 *
 * Also serves the built web app from dist/ when it exists, so one process is
 * enough in production. The Android app talks to it over the network.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import type { User } from '../src/types.ts'
import { auth, checkRs, HttpError, mock, REF_COLLECTIONS, refs, rsNameFromTin, saveCargo, saveRsSettings, shipments, viewFor, type RefCollection } from './logic.ts'
import { store } from './store.ts'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const DIST = join(import.meta.dirname, '..', 'dist')

type Ctx = { req: IncomingMessage; body: any; params: string[]; user: User; token: string }
type Handler = (c: Ctx) => unknown

const routes: [method: string, path: RegExp, handler: Handler, isPublic?: boolean][] = [
  ['POST', /^\/api\/login$/, ({ body }) => auth.login(body?.phone), true],
  ['POST', /^\/api\/logout$/, ({ token }) => auth.logout(token)],
  ['GET', /^\/api\/me$/, ({ user }) => user],
  [
    'GET',
    /^\/api\/state$/,
    // ?rev=N → 204 when nothing changed since N, so clients can poll cheaply.
    ({ req, user }) => {
      const since = Number(new URL(req.url!, 'http://x').searchParams.get('rev'))
      if (since === store.rev()) return NOT_MODIFIED
      return { rev: store.rev(), db: viewFor(user) }
    },
  ],
  ['PUT', /^\/api\/refs\/(\w+)$/, ({ params, body, user }) => refs.save(refCol(params[0]), body, user)],
  ['DELETE', /^\/api\/refs\/(\w+)\/([\w-]+)$/, ({ params, user }) => refs.remove(refCol(params[0]), params[1], user)],
  ['PUT', /^\/api\/cargo$/, ({ body, user }) => saveCargo(body, user)],
  ['PUT', /^\/api\/rs$/, ({ body, user }) => saveRsSettings(body ?? {}, user)],
  ['POST', /^\/api\/rs\/check$/, ({ body, user }) => checkRs(body, user)],
  ['POST', /^\/api\/rs\/name$/, ({ body, user }) => rsNameFromTin(body, user)],
  ['POST', /^\/api\/shipments$/, ({ body, user }) => ({ id: shipments.create(body ?? {}, user) })],
  ['POST', /^\/api\/shipments\/([\w-]+)\/run$/, ({ params, user }) => void shipments.run(params[0], user).catch(() => {})],
  ['POST', /^\/api\/shipments\/([\w-]+)\/retry-sms$/, ({ params, user }) => void shipments.retrySms(params[0], user).catch(() => {})],
  ['POST', /^\/api\/shipments\/([\w-]+)\/(close|cancel)$/, ({ params, user }) => shipments.finish(params[0], params[1] as 'close' | 'cancel', user)],
  ['PATCH', /^\/api\/mock\/settings$/, ({ body }) => mock.updateSettings(body ?? {})],
  ['DELETE', /^\/api\/mock\/logs$/, () => mock.clearLogs()],
  ['POST', /^\/api\/mock\/reset$/, ({ user }) => mock.reset(user)],
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

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const path = normalize(decodeURIComponent(new URL(req.url!, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, path)
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
  if (!existsSync(file)) return send(res, 404, { error: 'Not found' })
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size })
  createReadStream(file).pipe(res)
}

const server = createServer(async (req, res) => {
  // The Android app runs on its own origin (http://localhost), so allow cross-origin calls.
  // Auth is a bearer token, not a cookie, so this does not expose sessions to other sites.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return send(res, 204)

  const path = new URL(req.url!, 'http://x').pathname
  if (!path.startsWith('/api/')) return serveStatic(req, res)

  try {
    for (const [method, re, handler, isPublic] of routes) {
      const m = re.exec(path)
      if (!m || method !== req.method) continue
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      const user = auth.user(token)
      if (!user && !isPublic) throw new HttpError(401, 'სესია ამოიწურა — შედი თავიდან')
      const body = await readBody(req)
      const out = await handler({ req, body, params: m.slice(1), user: user!, token })
      if (out === NOT_MODIFIED) return send(res, 204)
      return send(res, 200, out ?? { ok: true })
    }
    send(res, 404, { error: 'Not found' })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    send(res, status, { error: status === 500 ? 'სერვერის შეცდომა' : (e as Error).message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`)
  shipments.resumeAll()
})
