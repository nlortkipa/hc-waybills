/**
 * The scale (სასწორი): the weighing service's Web API (an ASP.NET 6 app, "HBC-WEIGHING-API", over the
 * HCG-SCALES SQL Server database). Full description: docs/scale-api.md.
 *
 *   POST /auth/token                                 (no auth) → a JWT as plain text; it never expires
 *   POST /WeighingProcess/SAP_StartWeighingProcess   Bearer JWT, the order as JSON → { success, body, error }
 *
 * Each scale has its own API (ცნობარები → სასწორი: its ID and address); a shipment goes to the API
 * of its route's scale. A shipment is sent once RS.ge gives its waybill a number (the number is the order's DocEntry) with
 * the estimated weight (the waybill's quantity); the scale's operator weighs the truck, and the scale
 * posts the real weight back to SCALE_API's "SAP:API:URL:Output" address, which is our
 * POST /api/scale/weight (see receiveWeight in ./logic.ts).
 *
 * Every call goes to the integration log (the token is never logged).
 */
import type { IntegrationLog } from '../src/types.ts'
import { IntegrationError, log } from './integrations.ts'

const TIMEOUT_MS = 20_000

/** I adds the order (or replaces it while it isn't weighed), U changes it, D removes it. */
export type ScaleAction = 'I' | 'U' | 'D'

/** The order the scale takes (Web.API.Models.WeighingProcessInData). Field names as the API's JSON has them. */
export interface ScaleOrder {
  actionFlag: ScaleAction
  /** Operation, one letter; the scale only stores it. */
  processType: string
  /** The waybill number: the scale's order number. */
  docEntry: string
  /** Date of the order, local (Georgian) time without a zone. */
  docDate: string
  /** Buyer code and name: the waybill's buyer (on შიდა გადაზიდვა the seller itself). */
  cardCode: string
  cardName: string
  /** Delivery address code and address: kept only in the raw JSON the scale stores. */
  u_ShipToCodeS: string | null
  shipToCode: string | null
  u_DriverName: string
  /** Plate and trailer; the scale stores "plate/trailer". */
  u_TruckNum: string
  u_TruckNum2: string | null
  /** The scale's transport code: SCALE_TRUCK_CODE (T00002 = a truck not in its logistics fleet). */
  u_Truck: string
  /** Product code (must be in the scale's Goods table) and name. */
  itemCode: string
  description: string
  /** Estimated weight, in tonnes (the scale's unit is TO). */
  quantity: number
  /** Factory (warehouse) code: the route's scale ID; must be in the scale's Factories table. */
  whsCode: string
}

/** The scale's answer (Web.API.Models.ResponseModel<T>). */
interface Reply {
  success?: boolean
  error?: string | null
  body?: unknown
}

const scaleError = (message: string, rejected = false) => new IntegrationError('Scale', message, rejected)

/** A JWT per scale API address. */
const tokens = new Map<string, string>()

/** POSTs to a scale's API and logs the exchange. Returns the HTTP status and body; throws when no answer arrived. */
async function post(base: string, path: string, body: unknown, ctx: { bearer?: string; shipmentId?: string; logged?: unknown; readBack?: IntegrationLog['readBack'] }) {
  const endpoint = `POST ${base}${path}`
  const started = Date.now()
  let http = 0
  let raw = ''
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(ctx.bearer && { Authorization: `Bearer ${ctx.bearer}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    http = res.status
    raw = await res.text()
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError'
    const message = timeout ? 'სასწორის სერვისმა დროულად არ უპასუხა (timeout)' : `სასწორის სერვისი მიუწვდომელია: ${(e as Error).message}`
    log({ service: 'Scale', direction: 'out', endpoint, request: ctx.logged ?? body ?? null, response: { error: message }, ok: false, durationMs: Date.now() - started, shipmentId: ctx.shipmentId })
    throw scaleError(message)
  }
  return { http, raw, endpoint, started }
}

/** A JWT from the scale's /auth/token (held until the scale refuses it). */
async function getToken(base: string, fresh = false): Promise<string> {
  const held = tokens.get(base)
  if (held && !fresh) return held
  const { http, raw, endpoint, started } = await post(base, '/auth/token', undefined, {})
  const ok = http === 200 && /^[\w-]+\.[\w-]+\.[\w-]*$/.test(raw.trim())
  log({ service: 'Scale', direction: 'out', endpoint, request: null, response: { http, body: ok ? 'JWT ••••••' : raw.slice(0, 300) }, ok, durationMs: Date.now() - started })
  if (!ok) throw scaleError(`სასწორის სერვისმა ტოკენი ვერ გასცა (HTTP ${http})`)
  tokens.set(base, raw.trim())
  return raw.trim()
}

export const scale = {
  /**
   * Sends the order to the scale. Resolves when the scale took it; throws with the scale's own
   * (Georgian) reasons when it refused it. A refused order is still stored there, marked with the error,
   * and starts no weighing; sending it again (I or U) replaces it.
   */
  async send(url: string, order: ScaleOrder, shipmentId: string): Promise<void> {
    const base = url.replace(/\/+$/, '')
    const path = '/WeighingProcess/SAP_StartWeighingProcess'
    let r = await post(base, path, order, { bearer: await getToken(base), shipmentId })
    // The token was refused (the scale's key changed): once more with a new one.
    if (r.http === 401) r = await post(base, path, order, { bearer: await getToken(base, true), shipmentId })
    let reply: Reply | null = null
    try {
      const j = JSON.parse(r.raw) as Record<string, unknown>
      // A field missing or malformed: ASP.NET answers 400 with { title, errors: { Field: [why] } } itself.
      const invalid = j.errors && typeof j.errors === 'object' ? Object.values(j.errors as Record<string, string[]>).flat().join(';') : ''
      reply = { success: (j.success ?? j.Success) as boolean, error: invalid || ((j.error ?? j.Error) as string), body: j.body ?? j.Body }
    } catch {
      /* not JSON: an error page */
    }
    const ok = r.http === 200 && reply?.success === true
    log({
      service: 'Scale',
      direction: 'out',
      endpoint: r.endpoint,
      request: order,
      response: { http: r.http, body: reply ?? r.raw.slice(0, 300) },
      ok,
      durationMs: Date.now() - r.started,
      shipmentId,
    })
    if (ok) return
    if (r.http === 401) throw scaleError('სასწორის სერვისმა ავტორიზაცია არ მიიღო (HTTP 401)', true)
    if (!reply) throw scaleError(`სასწორის სერვისმა დააბრუნა შეცდომა (HTTP ${r.http})`, r.http < 500)
    // The scale's reasons end with ";" each.
    const why = String(reply.error ?? '').replace(/;\s*$/, '').replaceAll(';', '; ') || 'უცნობი შეცდომა'
    throw scaleError(`სასწორმა არ მიიღო: ${why}`, true)
  },
}
