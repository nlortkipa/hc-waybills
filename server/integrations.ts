/**
 * External services. RS.ge lives in ./rsge.ts (SOAP client, test service user);
 * SMS is still MOCKED here. Every call is written to the integration log so the
 * flow can be inspected in the Mock console.
 */
import { nowIso, sleep, uid } from '../src/lib/util.ts'
import type { IntegrationLog, ServiceName } from '../src/types.ts'
import { store as db } from './store.ts'

export class IntegrationError extends Error {
  readonly service: ServiceName
  constructor(service: ServiceName, message: string) {
    super(message)
    this.service = service
  }
}

export function log(entry: Omit<IntegrationLog, 'id' | 'at'>) {
  db.update((d) => ({
    ...d,
    logs: [{ id: uid('l'), at: nowIso(), ...entry }, ...d.logs].slice(0, 300),
  }))
}

export async function mockCall<T>(opts: {
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
