/**
 * Business rules. Every check that used to run in the browser runs here now, so a
 * client cannot skip it. Errors are thrown with the Georgian message shown to the user.
 */
import { randomBytes } from 'node:crypto'
import { resolveRoute } from '../src/lib/route.ts'
import { active, nowIso, phoneKey, uid } from '../src/lib/util.ts'
import type { CargoDefaults, Carrier, Database, MockSettings, Shipment, ShipmentEvent, User } from '../src/types.ts'
import { rsge, sms } from './integrations.ts'
import { store as db } from './store.ts'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
const fail = (message: string, status = 400): never => {
  throw new HttpError(status, message)
}

/* ------------------------------ Auth ------------------------------ */

export const auth = {
  /** No SMS code yet: a known number logs in straight away. */
  login(phone: string): { token: string; user: User } {
    const key = phoneKey(String(phone ?? ''))
    const user = active(db.get().users).find((u) => phoneKey(u.phone) === key)
    if (!key || !user) fail('ამ ნომრით მომხმარებელი ვერ მოიძებნა', 401)
    const token = randomBytes(24).toString('base64url')
    db.sessions.set(token, user!.id)
    return { token, user: user! }
  },
  user(token: string | undefined): User | null {
    const id = token && db.sessions.get(token)
    return (id && db.get().users.find((u) => u.id === id && !u.deletedAt)) || null
  },
  logout(token: string) {
    db.sessions.delete(token)
  },
}

/** What a user is allowed to see: operators only get their own carrier's shipments. */
export function viewFor(user: User): Database {
  const d = db.get()
  if (user.role !== 'operator') return d
  const mine = new Set(d.shipments.filter((s) => s.carrierId === user.carrierId).map((s) => s.id))
  return { ...d, shipments: d.shipments.filter((s) => mine.has(s.id)), logs: d.logs.filter((l) => l.shipmentId && mine.has(l.shipmentId)) }
}

/* ------------------------- Reference data ------------------------- */

export const REF_COLLECTIONS = ['carriers', 'drivers', 'trucks', 'users'] as const
export type RefCollection = (typeof REF_COLLECTIONS)[number]
type RefRecord = Database[RefCollection][number]

const requireAdmin = (u: User) => u.role === 'admin' || fail('მოქმედება ხელმისაწვდომია მხოლოდ ადმინისტრატორისთვის', 403)

function shipmentCount(col: RefCollection, id: string): number {
  const k = ({ carriers: 'carrierId', drivers: 'driverId', trucks: 'truckId', users: 'createdBy' } as const)[col]
  return db.get().shipments.filter((s) => s[k] === id).length
}

export const refs = {
  save(col: RefCollection, record: RefRecord & { id?: string }, by: User) {
    requireAdmin(by)
    const rec = { ...record, id: record.id || uid(col[0]) } as RefRecord
    const prev = (db.get()[col] as RefRecord[]).find((r) => r.id === rec.id)
    if (prev?.deletedAt) fail('ჩანაწერი წაშლილია')
    if (col === 'users') {
      const u = rec as User
      if (!phoneKey(u.phone ?? '')) fail('შეიყვანე ტელეფონის ნომერი')
      if (active(db.get().users).some((x) => x.id !== u.id && phoneKey(x.phone) === phoneKey(u.phone))) fail('ამ ტელეფონის ნომრით მომხმარებელი უკვე არსებობს')
      if (u.role === 'operator') {
        if (!u.carrierId || !active(db.get().carriers).some((c) => c.id === u.carrierId)) fail('ოპერატორს უნდა ჰქონდეს მიბმული კარიერი')
      } else delete u.carrierId
    }
    if (col === 'carriers') {
      const c = rec as Carrier
      if (!c.destinations?.length) fail('კარიერს უნდა ჰქონდეს მინიმუმ ერთი დასრულების მისამართი')
      c.destinations = c.destinations.map((x) => ({ ...x, id: x.id || uid('e') }))
      // Removed destinations that shipments still point at stay as soft-deleted so history resolves.
      const kept = new Set(c.destinations.map((x) => x.id))
      const used = new Set(db.get().shipments.filter((s) => s.carrierId === c.id).map((s) => s.destinationId))
      const at = nowIso()
      const gone = ((prev as Carrier | undefined)?.destinations ?? [])
        .filter((x) => !kept.has(x.id) && used.has(x.id))
        .map((x) => ({ ...x, deletedAt: x.deletedAt ?? at }))
      c.destinations = [...c.destinations, ...gone]
    }
    db.update((d) => {
      const list = d[col] as RefRecord[]
      return { ...d, [col]: prev ? list.map((r) => (r.id === rec.id ? rec : r)) : [...list, rec] }
    })
    return rec
  },

  /** Deletes a record. If shipments reference it, it is soft-deleted so reports keep showing it. */
  remove(col: RefCollection, id: string, by: User) {
    requireAdmin(by)
    if (col === 'users' && by.id === id) fail('წაშლა შეუძლებელია: საკუთარი ანგარიშის წაშლა შეუძლებელია.')
    if (col === 'carriers') {
      const n = active(db.get().users).filter((x) => x.role === 'operator' && x.carrierId === id).length
      if (n) fail(`წაშლა შეუძლებელია: მიბმულია ${n} ოპერატორთან — ჯერ შეცვალე ან წაშალე ისინი.`)
    }
    const soft = shipmentCount(col, id) > 0
    const at = nowIso()
    db.update((d) => {
      const list = d[col] as { id: string; deletedAt?: string }[]
      return { ...d, [col]: soft ? list.map((r) => (r.id === id ? { ...r, deletedAt: at } : r)) : list.filter((r) => r.id !== id) }
    })
  },
}

/* ------------------------------ Cargo ------------------------------ */

export function saveCargo(value: CargoDefaults, user: User) {
  if (user.role !== 'admin') fail('ფიქსირებული ტვირთის შეცვლა შეუძლია მხოლოდ ადმინისტრატორს', 403)
  const next: CargoDefaults = {
    description: String(value?.description ?? '').trim(),
    code: String(value?.code ?? '').trim(),
    quantity: Number(value?.quantity),
  }
  if (!next.description) fail('შეიყვანე ტვირთის დასახელება')
  if (!next.code) fail('შეიყვანე ტვირთის კოდი')
  if (!(next.quantity > 0)) fail('რაოდენობა უნდა იყოს 0-ზე მეტი')
  db.update((d) => ({ ...d, cargo: next }))
}

/* ---------------------------- Shipments ---------------------------- */

function patch(id: string, fn: (s: Shipment) => Partial<Shipment>, event?: Omit<ShipmentEvent, 'at'>) {
  db.update((d) => ({
    ...d,
    shipments: d.shipments.map((s) =>
      s.id === id ? { ...s, ...fn(s), events: event ? [...s.events, { at: nowIso(), ...event }] : s.events } : s,
    ),
  }))
}

function get(id: string, user?: User) {
  const s = db.get().shipments.find((x) => x.id === id)
  if (!s || (user?.role === 'operator' && s.carrierId !== user.carrierId)) return fail('რეისი ვერ მოიძებნა', 404)
  return s
}

const running = new Set<string>()

export interface NewShipmentInput {
  carrierId: string
  destinationId: string
  driverId: string
  truckId: string
}

export const shipments = {
  /** Creates the record and starts the upload pipeline in the background. */
  create(input: NewShipmentInput, user: User): string {
    if (user.role === 'report') fail('რეპორტ მომხმარებელს არ შეუძლია რეისის შექმნა', 403)
    if (user.role === 'operator' && input.carrierId !== user.carrierId) fail('ოპერატორს შეუძლია მხოლოდ საკუთარი კარიერის გამოყენება', 403)
    const d = db.get()
    const route = resolveRoute(d.carriers, input.carrierId, input.destinationId)
    if (!route.carrier || route.carrier.deletedAt) fail('კარიერი ვერ მოიძებნა ან წაშლილია')
    if (!route.destination || route.destination.deletedAt) fail('დასრულების მისამართი ვერ მოიძებნა')
    if (!active(d.drivers).some((x) => x.id === input.driverId)) fail('მძღოლი ვერ მოიძებნა ან წაშლილია')
    if (!active(d.trucks).some((x) => x.id === input.truckId)) fail('მანქანა ვერ მოიძებნა ან წაშლილია')
    // Cargo and declared quantity are fixed by the admin, never taken from the request.
    const { quantity, ...cargo } = d.cargo
    if (!cargo.description || !(quantity > 0)) fail('ფიქსირებული ტვირთი არ არის დაყენებული — მიმართე ადმინისტრატორს')
    const s: Shipment = {
      id: uid('s'),
      createdAt: nowIso(),
      createdBy: user.id,
      carrierId: input.carrierId,
      destinationId: input.destinationId,
      driverId: input.driverId,
      truckId: input.truckId,
      cargo,
      quantity,
      status: 'uploading',
      rs: { status: 'pending' },
      sms: { status: 'pending' },
      events: [{ at: nowIso(), level: 'info', message: 'მოთხოვნილია ზედნადების ატვირთვა' }],
    }
    db.update((d) => ({ ...d, shipments: [s, ...d.shipments] }))
    void shipments.run(s.id)
    return s.id
  },

  /** Runs (or resumes) the pipeline: RS.ge → SMS. Safe to call again for retries. */
  async run(id: string, user?: User) {
    get(id, user)
    if (user?.role === 'report') fail('რეპორტ მომხმარებელს არ შეუძლია ამ მოქმედების შესრულება', 403)
    if (running.has(id)) return
    running.add(id)
    try {
      await runPipeline(id)
    } finally {
      running.delete(id)
    }
  },

  async retrySms(id: string, user: User) {
    const s = get(id, user)
    if (user.role === 'report') fail('რეპორტ მომხმარებელს არ შეუძლია ამ მოქმედების შესრულება', 403)
    if (!s.waybillNumber || running.has(id)) return
    running.add(id)
    try {
      await sendSms(id)
    } finally {
      running.delete(id)
    }
  },

  /** On server start: finish pipelines interrupted by a restart. */
  resumeAll() {
    db.get()
      .shipments.filter((s) => s.status === 'uploading' || s.sms.status === 'running' || (s.status === 'uploaded' && s.sms.status === 'pending'))
      .forEach((s) => void shipments.run(s.id))
  },
}

async function runPipeline(id: string) {
  let s = get(id)
  const d = db.get()

  // 1. RS.ge — create waybill
  if (s.rs.status !== 'ok') {
    const route = resolveRoute(d.carriers, s.carrierId, s.destinationId)
    const driver = d.drivers.find((x) => x.id === s.driverId)!
    const truck = d.trucks.find((x) => x.id === s.truckId)!
    const carrier = d.carriers.find((x) => x.id === s.carrierId)!
    if (s.status === 'rs_failed') patch(id, () => ({}), { level: 'info', message: 'RS.ge-ზე ატვირთვის ხელახალი ცდა' })
    patch(id, () => ({ status: 'uploading', rs: { status: 'running' } }))
    try {
      const res = await rsge.createWaybill(
        {
          waybill_type: 2,
          seller_un_id: carrier.id,
          start_address: route.start,
          end_address: route.end,
          driver_tin: driver.personalId,
          driver_name: `${driver.firstName} ${driver.lastName}`,
          car_number: truck.plateNumber,
          trailer: truck.trailerNumber,
          transport_coast: 0,
          goods_list: [{ w_name: s.cargo.description, unit_id: 2, quantity: s.quantity, bar_code: s.cargo.code }],
        },
        id,
      )
      patch(
        id,
        () => ({ status: 'uploaded', waybillNumber: res.waybill_number, rs: { status: 'ok', at: nowIso() } }),
        { level: 'success', message: `RS.ge-მ დააბრუნა ზედნადები №${res.waybill_number}` },
      )
    } catch (e) {
      const msg = (e as Error).message
      patch(id, () => ({ status: 'rs_failed', rs: { status: 'failed', error: msg, at: nowIso() } }), { level: 'error', message: msg })
      return
    }
  }

  // 2. SMS to driver
  s = get(id)
  if (s.sms.status !== 'ok') await sendSms(id)
}

async function sendSms(id: string) {
  const s = get(id)
  const d = db.get()
  const driver = d.drivers.find((x) => x.id === s.driverId)!
  const route = resolveRoute(d.carriers, s.carrierId, s.destinationId)
  const truck = d.trucks.find((x) => x.id === s.truckId)!
  const text = `ზედნადები №${s.waybillNumber} ატვირთულია. მარშრუტი: ${route.start} → ${route.end}. მანქანა: ${truck.plateNumber}.`
  patch(id, (x) => ({ sms: { ...x.sms, status: 'running', to: driver.phone, text } }))
  try {
    await sms.send(driver.phone, text, id)
    patch(id, (x) => ({ sms: { ...x.sms, status: 'ok', error: undefined, at: nowIso() } }), {
      level: 'success',
      message: `მძღოლს გაეგზავნა SMS (${driver.phone})`,
    })
  } catch (e) {
    const msg = (e as Error).message
    patch(id, (x) => ({ sms: { ...x.sms, status: 'failed', error: msg, at: nowIso() } }), { level: 'error', message: msg })
  }
}

/* ------------------------------ Mock ------------------------------ */

export const mock = {
  updateSettings(p: Partial<MockSettings>) {
    const next: Partial<MockSettings> = {}
    for (const k of ['latencyMs', 'rsFailRate', 'smsFailRate'] as const) if (k in p && Number.isFinite(Number(p[k]))) next[k] = Number(p[k])
    db.update((d) => ({ ...d, settings: { ...d.settings, ...next } }))
  },
  clearLogs() {
    db.update((d) => ({ ...d, logs: [] }))
  },
  reset(user: User) {
    requireAdmin(user)
    db.reset()
  },
}
