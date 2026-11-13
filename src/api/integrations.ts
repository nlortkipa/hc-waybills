/**
 * External services: RS.ge and SMS are MOCKED; the Scale Service is mocked or
 * live (real HTTP), see scaleMode(). Every call is written to the integration
 * log so the flow can be inspected in the Mock console.
 * To go live with RS.ge/SMS, replace the bodies with real HTTP calls (server-side).
 */
import { db } from '../mock/db'
import { nowIso, sleep, uid } from '../lib/util'
import type { IntegrationLog, ScalePayload, ServiceName } from '../types'
import { scaleApiCallUrl, scaleApiUrl, scaleInspector, scaleInspectorUrl } from './scaleInspector'

export class IntegrationError extends Error {
  readonly service: ServiceName
  constructor(service: ServiceName, message: string) {
    super(message)
    this.service = service
  }
}

function log(entry: Omit<IntegrationLog, 'id' | 'at'>) {
  db.update((d) => ({
    ...d,
    logs: [{ id: uid('l'), at: nowIso(), ...entry }, ...d.logs].slice(0, 300),
  }))
}

async function mockCall<T>(opts: {
  service: ServiceName
  endpoint: string
  request: unknown
  failRate: number
  shipmentId?: string
  ok: () => T
  fail: () => { response: unknown; message: string }
}): Promise<T> {
  const { latencyMs } = db.get().settings
  const duration = Math.max(50, Math.round(latencyMs * (0.6 + Math.random() * 0.8)))
  await sleep(duration)
  if (Math.random() * 100 < opts.failRate) {
    const f = opts.fail()
    log({ service: opts.service, direction: 'out', endpoint: opts.endpoint, request: opts.request, response: f.response, ok: false, durationMs: duration, shipmentId: opts.shipmentId })
    throw new IntegrationError(opts.service, f.message)
  }
  const res = opts.ok()
  log({ service: opts.service, direction: 'out', endpoint: opts.endpoint, request: opts.request, response: res, ok: true, durationMs: duration, shipmentId: opts.shipmentId })
  return res
}

/* ----------------------------- RS.ge ----------------------------- */

export interface RsWaybillRequest {
  waybill_type: number
  seller_un_id: string
  start_address: string
  end_address: string
  driver_tin: string
  driver_name: string
  car_number: string
  trailer: string
  transport_coast: number
  goods_list: { w_name: string; unit_id: number; quantity: number; bar_code: string }[]
}

export const rsge = {
  createWaybill(req: RsWaybillRequest, shipmentId: string) {
    return mockCall({
      service: 'RS.ge',
      endpoint: 'POST services.rs.ge/WayBillService › save_waybill',
      request: req,
      failRate: db.get().settings.rsFailRate,
      shipmentId,
      ok: () => {
        const id = Math.floor(100000000 + Math.random() * 899999999)
        return {
          status: 0,
          waybill_id: id,
          waybill_number: String(4100000000 + Math.floor(Math.random() * 99999999)),
        }
      },
      fail: () => ({
        response: { status: -1012, message: 'Driver TIN is not valid' },
        message: 'RS.ge: მძღოლის პირადი ნომერი არასწორია (კოდი -1012)',
      }),
    })
  },
}

/* ------------------------------ SMS ------------------------------ */

export const sms = {
  send(to: string, text: string, shipmentId: string) {
    return mockCall({
      service: 'SMS',
      endpoint: 'POST sms-provider/api/send',
      request: { from: 'HC', to: to.replace(/\s/g, ''), text },
      failRate: db.get().settings.smsFailRate,
      shipmentId,
      ok: () => ({ messageId: uid('msg_'), status: 'queued' }),
      fail: () => ({ response: { status: 'error', error: 'Gateway timeout' }, message: 'SMS სერვისმა არ უპასუხა (timeout)' }),
    })
  },
}

/* ----------------------------- Scale ----------------------------- */
/*
 * Two modes, switched in the Mock console:
 *   mock — simulated like RS.ge and SMS.
 *   live — real HTTP calls to the client's Scale Service (VITE_SCALE_API_URL,
 *          http://localhost:5080 in dev = the Docker stack from `npm run scale up`).
 */

export type ScaleMode = 'mock' | 'live'

export const scaleLiveAvailable = !!scaleApiCallUrl

export function scaleMode(): ScaleMode {
  const m = db.get().settings.scaleMode ?? (scaleLiveAvailable ? 'live' : 'mock')
  return m === 'live' && scaleLiveAvailable ? 'live' : 'mock'
}

let mockToken: string | null = null
let liveToken: { value: string; expiresAt: number } | null = null

/** Reads `exp` from a JWT so the token is refreshed before the API rejects it. */
function jwtExpiry(token: string): number {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const exp = (JSON.parse(atob(b64)) as { exp?: number }).exp
    if (exp) return exp * 1000
  } catch {
    /* not a JWT we can read — fall through */
  }
  return Date.now() + 10 * 60_000
}

interface LiveResult {
  status: number
  body: unknown
  durationMs: number
}

async function liveFetch(path: string, init: RequestInit): Promise<LiveResult> {
  const started = performance.now()
  let res: Response
  try {
    res = await fetch(scaleApiCallUrl + path, { ...init, signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    const durationMs = Math.round(performance.now() - started)
    const timeout = (e as Error).name === 'TimeoutError'
    return { status: 0, body: { error: timeout ? 'timeout (30s)' : String((e as Error).message ?? e) }, durationMs }
  }
  const text = await res.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* plain-text body (e.g. /auth/token) */
  }
  return { status: res.status, body, durationMs: Math.round(performance.now() - started) }
}

// 0 = fetch failed; 502/504 = the dev proxy couldn't reach the API.
const isDown = (r: LiveResult) => r.status === 0 || r.status === 502 || r.status === 504

function unreachable(r: LiveResult) {
  return new IntegrationError('Scale', isDown(r) ? `სასწორის სერვისთან კავშირი ვერ დამყარდა (${scaleApiUrl}) — გაშვებულია \`npm run scale up\`?` : `სასწორის სერვისმა დააბრუნა HTTP ${r.status}`)
}

/** Turns the API's error shapes into one readable message. */
function scaleErrorMessage(r: LiveResult): string {
  const b = r.body as { error?: string; errors?: Record<string, string[]>; title?: string } | null
  if (b && typeof b === 'object') {
    if (b.errors) return `სასწორმა უარყო მონაცემები: ${Object.values(b.errors).flat().join('; ')}`
    if (b.error) return `სასწორმა უარყო ზედნადები: ${b.error.split(';').map((x) => x.trim()).filter(Boolean).join('; ')}`
    if (b.title) return `სასწორის სერვისი: ${b.title} (HTTP ${r.status})`
  }
  return `სასწორის სერვისმა დააბრუნა HTTP ${r.status}`
}

async function getLiveToken(force = false): Promise<string> {
  if (!force && liveToken && liveToken.expiresAt - 60_000 > Date.now()) return liveToken.value
  liveToken = null
  const r = await liveFetch('/auth/token', { method: 'POST' })
  const token = typeof r.body === 'string' ? r.body.trim() : ''
  const ok = r.status === 200 && !!token
  log({
    service: 'Scale',
    direction: 'out',
    endpoint: `POST ${scaleApiUrl}/auth/token`,
    request: null,
    response: ok ? { token: `${token.slice(0, 16)}…`, expiresAt: new Date(jwtExpiry(token)).toISOString() } : r.body,
    ok,
    durationMs: r.durationMs,
  })
  if (!ok) throw unreachable(r)
  liveToken = { value: token, expiresAt: jwtExpiry(token) }
  return token
}

async function liveSendWaybill(payload: ScalePayload, shipmentId: string) {
  const endpoint = `POST ${scaleApiUrl}/WeighingProcess/SAP_StartWeighingProcess`
  const call = async (token: string) =>
    liveFetch('/WeighingProcess/SAP_StartWeighingProcess', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
  let r = await call(await getLiveToken())
  if (r.status === 401) r = await call(await getLiveToken(true))
  const body = r.body as { success?: boolean } | null
  const ok = r.status === 200 && body?.success === true
  log({ service: 'Scale', direction: 'out', endpoint, request: payload, response: r.body, ok, durationMs: r.durationMs, shipmentId })
  if (ok) return { success: true, docEntry: payload.docEntry }
  if (isDown(r) || (r.status >= 500 && !(body && typeof body === 'object' && 'error' in body))) throw unreachable(r)
  throw new IntegrationError('Scale', scaleErrorMessage(r))
}

export const scale = {
  async ensureToken() {
    if (mockToken) return mockToken
    const res = await mockCall({
      service: 'Scale',
      endpoint: 'POST /auth/token',
      request: null,
      failRate: 0,
      ok: () => ({ token: 'eyJhbGciOi…mock' }),
      fail: () => ({ response: {}, message: '' }),
    })
    mockToken = res.token
    return mockToken
  },

  async sendWaybill(payload: ScalePayload, shipmentId: string) {
    if (scaleMode() === 'live') return liveSendWaybill(payload, shipmentId)
    await scale.ensureToken()
    return mockCall({
      service: 'Scale',
      endpoint: 'POST /WeighingProcess/SAP_StartWeighingProcess',
      request: payload,
      failRate: db.get().settings.scaleFailRate,
      shipmentId,
      ok: () => ({ success: true, error: null, body: payload }),
      fail: () => ({ response: { success: false, error: 'Scale service unavailable (503)' }, message: 'სასწორის სერვისი მიუწვდომელია (503)' }),
    })
  },

  /**
   * Live mode: asks the scale DB (through the inspector) whether the truck was weighed.
   * Returns the net weight once it exists, otherwise null. Throws nothing — a failed
   * poll is simply retried on the next tick.
   */
  async pollWeight(docEntry: string): Promise<{ weightKg: number; weighedAt: string; statusName?: string } | null> {
    try {
      const w = await scaleInspector.weighing(docEntry, AbortSignal.timeout(8000))
      if (!w.found || !w.weightKg) return null
      return { weightKg: w.weightKg, weighedAt: w.weighedAt ?? nowIso(), statusName: w.statusName }
    } catch {
      return null
    }
  },

  /** The weight reaching us — logged as an incoming call. */
  logWeightCallback(docEntry: string, weightKg: number, shipmentId: string, source: 'mock' | 'live' = 'mock') {
    log({
      service: 'Scale',
      direction: 'in',
      endpoint: source === 'live' ? `GET ${scaleInspectorUrl}/api/weighings/${docEntry} (scale DB)` : 'POST /api/hc/weight (callback from Scale)',
      request: { docEntry },
      response: { docEntry, weight: weightKg },
      ok: true,
      durationMs: 0,
      shipmentId,
    })
  },
}
