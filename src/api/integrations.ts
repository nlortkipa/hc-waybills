/**
 * External services: RS.ge and SMS are MOCKED. Every call is written to the
 * integration log so the flow can be inspected in the Mock console.
 * To go live, replace the bodies with real HTTP calls (server-side).
 */
import { db } from '../mock/db'
import { nowIso, sleep, uid } from '../lib/util'
import type { IntegrationLog, ServiceName } from '../types'

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
