/**
 * App-facing API. Today it talks to the in-browser mock DB; later each function
 * becomes a fetch() to the real backend with the same signature.
 */
import { db } from '../mock/db'
import { active, formatKg, nowIso, sleep, uid } from '../lib/util'
import { resolveRoute } from '../lib/route'
import type { CargoDefaults, Carrier, Database, Shipment, ShipmentEvent, User } from '../types'
import { rsge, scale, scaleMode, sms, weighingMocked } from './integrations'
import { buildScalePayload } from './scalePayload'

const quick = () => sleep(150 + Math.random() * 150)

/* ------------------------------ Auth ------------------------------ */

const SESSION_KEY = 'hc.session'

export const auth = {
  current(): User | null {
    try {
      const id = localStorage.getItem(SESSION_KEY)
      return db.get().users.find((u) => u.id === id && !u.deletedAt) ?? null
    } catch {
      return null
    }
  },
  async loginAs(userId: string): Promise<User> {
    await quick()
    const user = db.get().users.find((u) => u.id === userId)
    if (!user || user.deletedAt) throw new Error('მომხმარებელი ვერ მოიძებნა')
    try {
      localStorage.setItem(SESSION_KEY, user.id)
    } catch {
      /* ignore */
    }
    return user
  },
  logout() {
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
  },
}

/* ------------------------- Reference data ------------------------- */

export type RefCollection = 'carriers' | 'drivers' | 'trucks' | 'users'
type RefRecord<K extends RefCollection> = Database[K][number]

export const refs = {
  async save<K extends RefCollection>(col: K, record: Omit<RefRecord<K>, 'id'> & { id?: string }) {
    await quick()
    const rec = { ...record, id: record.id || uid(col[0]) } as RefRecord<K>
    const prev = (db.get()[col] as RefRecord<K>[]).find((r) => r.id === rec.id)
    if (prev?.deletedAt) throw new Error('ჩანაწერი წაშლილია')
    if (col === 'users') {
      const u = rec as User
      if (u.role === 'operator') {
        if (!u.carrierId || !active(db.get().carriers).some((c) => c.id === u.carrierId)) throw new Error('ოპერატორს უნდა ჰქონდეს მიბმული კარიერი')
      } else delete u.carrierId
    }
    if (col === 'carriers') {
      const c = rec as Carrier
      if (!c.destinations?.length) throw new Error('კარიერს უნდა ჰქონდეს მინიმუმ ერთი დასრულების მისამართი')
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
      const list = d[col] as RefRecord<K>[]
      return { ...d, [col]: prev ? list.map((r) => (r.id === rec.id ? rec : r)) : [...list, rec] }
    })
    return rec
  },

  /** Number of shipments that reference the record (they keep showing it after deletion). */
  shipmentCount(col: RefCollection, id: string): number {
    const k = ({ carriers: 'carrierId', drivers: 'driverId', trucks: 'truckId', users: 'createdBy' } as const)[col]
    return db.get().shipments.filter((s) => s[k] === id).length
  },

  /** Returns why a record cannot be deleted, or null if it can. */
  blocker(col: RefCollection, id: string, by?: User): string | null {
    if (col === 'users' && by?.id === id) return 'საკუთარი ანგარიშის წაშლა შეუძლებელია.'
    if (col === 'carriers') {
      const u = refs.boundOperators(id)
      if (u) return `მიბმულია ${u} ოპერატორთან — ჯერ შეცვალე ან წაშალე ისინი.`
    }
    return null
  },

  /** Active operators bound to a carrier — they can no longer create shipments once it is deleted. */
  boundOperators(carrierId: string): number {
    return active(db.get().users).filter((x) => x.role === 'operator' && x.carrierId === carrierId).length
  },

  /** Deletes a record. If shipments reference it, it is soft-deleted so reports keep showing it. */
  async remove(col: RefCollection, id: string, by?: User) {
    await quick()
    const reason = refs.blocker(col, id, by)
    if (reason) throw new Error(`წაშლა შეუძლებელია: ${reason}`)
    const soft = refs.shipmentCount(col, id) > 0
    const at = nowIso()
    db.update((d) => {
      const list = d[col] as { id: string; deletedAt?: string }[]
      return { ...d, [col]: soft ? list.map((r) => (r.id === id ? { ...r, deletedAt: at } : r)) : list.filter((r) => r.id !== id) }
    })
  },
}

/* ------------------------------ Cargo ------------------------------ */

export const cargo = {
  /** Sets the cargo and declared quantity used for every new shipment. Admin only. */
  async save(value: CargoDefaults, user: User) {
    if (user.role !== 'admin') throw new Error('ფიქსირებული ტვირთის შეცვლა შეუძლია მხოლოდ ადმინისტრატორს')
    await quick()
    const next: CargoDefaults = {
      description: value.description.trim(),
      code: value.code.trim(),
      whsCode: value.whsCode.trim(),
      quantity: value.quantity,
    }
    if (!next.description) throw new Error('შეიყვანე ტვირთის დასახელება')
    if (!(next.quantity > 0) || next.quantity > 60) throw new Error('რაოდენობა უნდა იყოს 0-დან 60 ტ-მდე')
    db.update((d) => ({ ...d, cargo: next }))
  },
}

/* ---------------------------- Shipments ---------------------------- */

export function visibleShipments(d: Database, user: User): Shipment[] {
  const list = user.role === 'operator' ? d.shipments.filter((s) => s.carrierId === user.carrierId) : d.shipments
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function patch(id: string, fn: (s: Shipment) => Partial<Shipment>, event?: Omit<ShipmentEvent, 'at'>) {
  db.update((d) => ({
    ...d,
    shipments: d.shipments.map((s) =>
      s.id === id ? { ...s, ...fn(s), events: event ? [...s.events, { at: nowIso(), ...event }] : s.events } : s,
    ),
  }))
}

const get = (id: string) => {
  const s = db.get().shipments.find((x) => x.id === id)
  if (!s) throw new Error('რეისი ვერ მოიძებნა')
  return s
}

const running = new Set<string>()
const weighTimers = new Map<string, number>()

export interface NewShipmentInput {
  carrierId: string
  destinationId: string
  driverId: string
  truckId: string
}

export const shipments = {
  /** Creates the record and immediately starts the upload pipeline. */
  async create(input: NewShipmentInput, user: User): Promise<string> {
    if (user.role === 'report') throw new Error('რეპორტ მომხმარებელს არ შეუძლია რეისის შექმნა')
    if (user.role === 'operator' && input.carrierId !== user.carrierId) throw new Error('ოპერატორს შეუძლია მხოლოდ საკუთარი კარიერის გამოყენება')
    await quick()
    const d = db.get()
    const route = resolveRoute(d.carriers, input.carrierId, input.destinationId)
    if (!route.carrier || route.carrier.deletedAt) throw new Error('კარიერი ვერ მოიძებნა ან წაშლილია')
    if (!route.destination || route.destination.deletedAt) throw new Error('დასრულების მისამართი ვერ მოიძებნა')
    if (!active(d.drivers).some((x) => x.id === input.driverId)) throw new Error('მძღოლი ვერ მოიძებნა ან წაშლილია')
    if (!active(d.trucks).some((x) => x.id === input.truckId)) throw new Error('მანქანა ვერ მოიძებნა ან წაშლილია')
    // Cargo and declared quantity are fixed by the admin, never taken from the request.
    const { quantity, ...cargo } = d.cargo
    if (!cargo.description || !(quantity > 0)) throw new Error('ფიქსირებული ტვირთი არ არის დაყენებული — მიმართე ადმინისტრატორს')
    const s: Shipment = {
      id: uid('s'),
      createdAt: nowIso(),
      createdBy: user.id,
      ...input,
      cargo,
      quantity,
      status: 'uploading',
      rs: { status: 'pending' },
      sms: { status: 'pending' },
      scale: { status: 'pending' },
      events: [{ at: nowIso(), level: 'info', message: 'მოთხოვნილია ზედნადების ატვირთვა' }],
    }
    db.update((d) => ({ ...d, shipments: [s, ...d.shipments] }))
    void shipments.run(s.id)
    return s.id
  },

  /** Runs (or resumes) the pipeline: RS.ge → SMS → Scale. Safe to call again for retries. */
  async run(id: string) {
    if (running.has(id)) return
    running.add(id)
    try {
      await runPipeline(id)
    } finally {
      running.delete(id)
    }
  },

  async retrySms(id: string) {
    const s = get(id)
    if (!s.waybillNumber) return
    await sendSms(id)
  },

  /** Simulates the truck being weighed: the scale calls us back with docEntry + weight. */
  async simulateWeighing(id: string, weightKg?: number) {
    const s = get(id)
    if (s.status !== 'at_scale' || !s.waybillNumber) return
    clearTimeout(weighTimers.get(id))
    weighTimers.delete(id)
    const w = weightKg ?? Math.round(s.quantity * 1000 * (0.96 + Math.random() * 0.08))
    markWeighed(id, w, nowIso(), 'mock')
  },

  /** Re-arms auto-weighing timers after a page reload. */
  resumeAutoWeigh() {
    db.get().shipments.filter((s) => s.status === 'at_scale').forEach((s) => scheduleAutoWeigh(s.id))
  },

  /** Called once on app start: finishes pipelines interrupted by a reload. Returns a cleanup. */
  resumeAll() {
    db.get()
      .shipments.filter((s) => s.status === 'uploading' || s.status === 'uploaded' || s.sms.status === 'running' || s.scale.status === 'running')
      .forEach((s) => void shipments.run(s.id))
    shipments.resumeAutoWeigh()
    void pollLiveWeights()
    const t = window.setInterval(() => void pollLiveWeights(), LIVE_POLL_MS)
    return () => window.clearInterval(t)
  },

  isRunning: (id: string) => running.has(id),
}

function markWeighed(id: string, weightKg: number, weighedAt: string, source: 'mock' | 'live') {
  const s = get(id)
  if (s.status !== 'at_scale' || !s.waybillNumber) return
  scale.logWeightCallback(s.waybillNumber, weightKg, id, source)
  patch(
    id,
    (x) => ({ status: 'weighed', scale: { ...x.scale, weightKg, weighedAt } }),
    { level: 'success', message: `აიწონა: ${formatKg(weightKg)} (docEntry ${s.waybillNumber})` },
  )
}

/* Live scale: the vendor API pushes the weight to SAP, not to us, so we read it
   from the scale DB for every shipment still waiting at the scale. */
const LIVE_POLL_MS = 15_000
let polling = false

async function pollLiveWeights() {
  if (polling || weighingMocked()) return
  polling = true
  try {
    const waiting = db.get().shipments.filter((s) => s.status === 'at_scale' && s.waybillNumber)
    for (const s of waiting) {
      const w = await scale.pollWeight(s.waybillNumber!)
      if (w) markWeighed(s.id, w.weightKg, w.weighedAt, 'live')
    }
  } finally {
    polling = false
  }
}

function scheduleAutoWeigh(id: string) {
  const { autoWeigh, autoWeighDelaySec } = db.get().settings
  if (!weighingMocked() || !autoWeigh || weighTimers.has(id)) return
  const t = window.setTimeout(() => {
    weighTimers.delete(id)
    if (db.get().settings.autoWeigh && weighingMocked()) void shipments.simulateWeighing(id)
  }, autoWeighDelaySec * 1000)
  weighTimers.set(id, t)
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
          seller_un_id: carrier.code,
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

  // 2. SMS to driver — failure does not block the scale hand-off
  s = get(id)
  if (s.sms.status !== 'ok') await sendSms(id)

  // 3. Scale Service — hand over the waybill
  s = get(id)
  if (s.scale.status !== 'ok') {
    const payload = buildScalePayload(s, db.get())
    if (s.status === 'scale_failed') patch(id, () => ({}), { level: 'info', message: 'სასწორზე გაგზავნის ხელახალი ცდა' })
    patch(id, (x) => ({ scale: { ...x.scale, status: 'running', payload } }))
    try {
      await scale.sendWaybill(payload, id)
      patch(
        id,
        (x) => ({ status: 'at_scale', scale: { ...x.scale, status: 'ok', error: undefined, sentAt: nowIso() } }),
        { level: 'success', message: `ზედნადები გაიგზავნა სასწორზე${scaleMode() === 'live' ? ' (რეალური სერვისი)' : ''} — ელოდება აწონვას` },
      )
      scheduleAutoWeigh(id)
    } catch (e) {
      const msg = (e as Error).message
      patch(id, (x) => ({ status: 'scale_failed', scale: { ...x.scale, status: 'failed', error: msg } }), { level: 'error', message: msg })
    }
  }
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
  updateSettings(p: Partial<Database['settings']>) {
    db.update((d) => ({ ...d, settings: { ...d.settings, ...p } }))
    if (!weighingMocked()) {
      weighTimers.forEach((t) => clearTimeout(t))
      weighTimers.clear()
      void pollLiveWeights()
    }
    if (p.autoWeigh || p.scaleMode) shipments.resumeAutoWeigh()
  },
  clearLogs() {
    db.update((d) => ({ ...d, logs: [] }))
  },
  reset() {
    weighTimers.forEach((t) => clearTimeout(t))
    weighTimers.clear()
    db.reset()
  },
}
