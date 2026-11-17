/**
 * Business rules. Every check that used to run in the browser runs here now, so a
 * client cannot skip it. Errors are thrown with the Georgian message shown to the user.
 */
import { resolveRoute } from '../src/lib/route.ts'
import { RS_TRANS_OTHER, RS_UNIT_OTHER, rsMissing } from '../src/lib/rs.ts'
import { active, nowIso, phoneKey, uid } from '../src/lib/util.ts'
import type { CargoDefaults, Carrier, Database, Driver, MockSettings, RsSettings, RsWaybillPayload, Shipment, ShipmentEvent, User } from '../src/types.ts'
import { IntegrationError, sms } from './integrations.ts'
import { resetRsCache, rsge, storedCreds, type RsCreds } from './rsge.ts'
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
    return { token: db.sessions.create(user!.id), user: user! }
  },
  user(token: string | undefined): User | null {
    const id = token && db.sessions.get(token)
    return (id && db.get().users.find((u) => u.id === id && !u.deletedAt)) || null
  },
  logout(token: string) {
    db.sessions.delete(token)
  },
}

/** What a user is allowed to see: operators only get their own carrier's shipments. The RS.ge password never leaves the server. */
export function viewFor(user: User): Database {
  const raw = db.get()
  const d: Database = { ...raw, rs: { ...raw.rs, sp: '', spSet: !!raw.rs.sp, su: user.role === 'admin' ? raw.rs.su : '' } }
  if (user.role !== 'operator') return d
  const mine = new Set(d.shipments.filter((s) => s.carrierId === user.carrierId).map((s) => s.id))
  return { ...d, shipments: d.shipments.filter((s) => mine.has(s.id)), logs: d.logs.filter((l) => l.shipmentId && mine.has(l.shipmentId)) }
}

/* ------------------------- Reference data ------------------------- */

export const REF_COLLECTIONS = ['carriers', 'drivers', 'trucks', 'users'] as const
export type RefCollection = (typeof REF_COLLECTIONS)[number]
type RefRecord = Database[RefCollection][number]

const requireAdmin = (u: User) => u.role === 'admin' || fail('მოქმედება ხელმისაწვდომია მხოლოდ ადმინისტრატორისთვის', 403)

/** Active admins other than `id`. The last admin can't be deleted or demoted, so the system always has one. */
const otherAdmins = (id: string) => active(db.get().users).filter((u) => u.role === 'admin' && u.id !== id).length
const LAST_ADMIN = 'ეს ერთადერთი ადმინისტრატორია — ჯერ დანიშნე სხვა ადმინისტრატორი.'

function shipmentCount(col: RefCollection, id: string): number {
  const k = ({ carriers: 'carrierId', drivers: 'driverId', trucks: 'truckId', users: 'createdBy' } as const)[col]
  return db.get().shipments.filter((s) => s[k] === id).length
}

export const refs = {
  /** `token` is the caller's session: kept when admins change their own phone or role. */
  async save(col: RefCollection, record: RefRecord & { id?: string }, by: User, token?: string) {
    requireAdmin(by)
    const rec = { ...record, id: record.id || uid(col[0]) } as RefRecord
    const prev = (db.get()[col] as RefRecord[]).find((r) => r.id === rec.id)
    if (prev?.deletedAt) fail('ჩანაწერი წაშლილია')
    let revokeSessions = false
    if (col === 'users') {
      const u = rec as User
      const was = prev as User | undefined
      if (!['admin', 'operator', 'report'].includes(u.role)) fail('აირჩიე როლი')
      if (was?.role === 'admin' && u.role !== 'admin' && !otherAdmins(u.id)) fail(`როლის შეცვლა შეუძლებელია: ${LAST_ADMIN}`)
      // A new phone may belong to someone else now, and a new role changes what the user may do: log them out everywhere.
      revokeSessions = !!was && (phoneKey(was.phone) !== phoneKey(u.phone) || was.role !== u.role)
      if (!phoneKey(u.phone ?? '')) fail('შეიყვანე ტელეფონის ნომერი')
      if (active(db.get().users).some((x) => x.id !== u.id && phoneKey(x.phone) === phoneKey(u.phone))) fail('ამ ტელეფონის ნომრით მომხმარებელი უკვე არსებობს')
      if (u.role === 'operator') {
        if (!u.carrierId || !active(db.get().carriers).some((c) => c.id === u.carrierId)) fail('ოპერატორს უნდა ჰქონდეს მიბმული კარიერი')
      } else delete u.carrierId
    }
    if (col === 'drivers') {
      const x = rec as Driver
      x.citizenship = x.citizenship === 'foreign' ? 'foreign' : 'GE'
      if (x.citizenship === 'GE' && !/^\d{11}$/.test(String(x.personalId ?? '').trim())) fail('პირადი ნომერი უნდა იყოს 11 ციფრი')
      x.personalId = String(x.personalId ?? '').trim()
      if (!x.personalId) fail('შეიყვანე პირადი ნომერი')
      const was = prev as Driver | undefined
      // RS.ge checks the driver on every waybill: a Georgian number must be in its register
      // (code -1014) and a registered number may not be sent as foreign (code -1065). Check it now,
      // not at the first upload. Skipped while RS.ge isn't connected.
      if (storedCreds() && (!was || was.personalId.trim() !== x.personalId || (was.citizenship ?? 'GE') !== x.citizenship)) {
        const name = await georgianName(x.personalId)
        if (x.citizenship === 'GE' && !name) fail('ეს პირადი ნომერი RS.ge-ს რეესტრში ვერ მოიძებნა')
        if (x.citizenship === 'foreign' && name) fail('ეს პირადი ნომერი საქართველოს რეესტრშია — აირჩიე „საქართველოს მოქალაქე“')
      }
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
    db.put(col, rec as never)
    if (revokeSessions) db.sessions.deleteForUser(rec.id, rec.id === by.id ? token : undefined)
    return rec
  },

  /** Deletes a record. If shipments reference it, it is soft-deleted so reports keep showing it. */
  remove(col: RefCollection, id: string, by: User) {
    requireAdmin(by)
    if (col === 'users') {
      const u = db.get().users.find((x) => x.id === id)
      if (u?.role === 'admin' && !u.deletedAt && !otherAdmins(id)) fail(`წაშლა შეუძლებელია: ${LAST_ADMIN}`)
    }
    if (col === 'carriers') {
      const n = active(db.get().users).filter((x) => x.role === 'operator' && x.carrierId === id).length
      if (n) fail(`წაშლა შეუძლებელია: მიბმულია ${n} ოპერატორთან — ჯერ შეცვალე ან წაშალე ისინი.`)
    }
    const rec = (db.get()[col] as RefRecord[]).find((r) => r.id === id)
    if (!rec) fail('ჩანაწერი ვერ მოიძებნა', 404)
    if (shipmentCount(col, id) > 0) db.put(col, { ...rec!, deletedAt: rec!.deletedAt ?? nowIso() } as never)
    else db.remove(col, id)
    if (col === 'users') db.sessions.deleteForUser(id)
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
  db.set('cargo', next)
}

/* ------------------------------ RS.ge ------------------------------ */

const str = (v: unknown) => String(v ?? '').trim()
const num = (v: unknown, fallback = 0) => (v === '' || v == null || !Number.isFinite(Number(v)) ? fallback : Number(v))

/** Saves the admin's RS.ge settings. An empty password keeps the stored one. */
/**
 * Saves the waybill defaults (buyer, transport, unit, price…). The service user is not part of
 * this: it is set only by connectRs, after RS.ge accepted it. For a Georgian buyer the name is
 * taken from RS.ge, so it always matches the register.
 */
export async function saveRsSettings(v: Partial<RsSettings>, user: User) {
  requireAdmin(user)
  const prev = db.get().rs
  const next: RsSettings = {
    ...prev,
    buyerTin: str(v.buyerTin),
    buyerName: str(v.buyerName),
    buyerForeign: !!v.buyerForeign,
    transporterTin: str(v.transporterTin),
    transId: num(v.transId, 1),
    transTxt: str(v.transTxt),
    tranCostPayer: Number(v.tranCostPayer) === 1 ? 1 : 2,
    transportCost: num(v.transportCost),
    unitId: num(v.unitId, RS_UNIT_OTHER),
    unitTxt: str(v.unitTxt),
    price: num(v.price),
    vatType: ([0, 1, 2] as const).find((x) => x === Number(v.vatType)) ?? 0,
    receptionInfo: str(v.receptionInfo),
    receiverInfo: str(v.receiverInfo),
    comment: str(v.comment),
  }
  delete next.spSet
  if (next.buyerTin && !/^\d{9}$|^\d{11}$/.test(next.buyerTin) && !next.buyerForeign) fail('მყიდველის ს/ნ უნდა იყოს 9 (კომპანია) ან 11 (ფიზიკური პირი) ციფრი')
  if (next.buyerTin && next.buyerTin === prev.sellerTin) fail('მყიდველი ვერ იქნება თავად გამყიდველი — RS.ge ასეთ ზედნადებს არ იღებს')
  if (next.buyerForeign && !next.buyerName) fail('უცხოელი მყიდველისთვის შეიყვანე დასახელება')
  if (next.transporterTin && !/^\d{9}$|^\d{11}$/.test(next.transporterTin)) fail('გადამზიდავის ს/ნ უნდა იყოს 9 ან 11 ციფრი')
  if (next.price < 0 || next.transportCost < 0) fail('თანხა არ შეიძლება იყოს უარყოფითი')
  if (next.unitId === RS_UNIT_OTHER && !next.unitTxt) fail('„სხვა“ ერთეულისთვის შეიყვანე ერთეულის დასახელება')
  if (next.transId === RS_TRANS_OTHER && !next.transTxt) fail('„სხვა“ ტრანსპორტისთვის შეიყვანე ტიპის დასახელება')
  // Georgian buyer: the name always comes from RS.ge, never from what was stored or typed
  // (RS.ge itself ignores BUYER_NAME and writes the registered name into the waybill).
  if (next.buyerTin && !next.buyerForeign) next.buyerName = await lookupName(next.buyerTin, 'მყიდველი')
  // A number in the Georgian register sent as "foreign" is refused by RS.ge (code -1066).
  if (next.buyerForeign && /^\d{9}$|^\d{11}$/.test(next.buyerTin) && (await georgianName(next.buyerTin))) fail(GEORGIAN_AS_FOREIGN)
  db.set('rs', next)
}

const GEORGIAN_AS_FOREIGN = 'ეს ნომერი საქართველოს რეესტრშია — გამორთე „უცხოელი“, RS.ge სხვაგვარად ზედნადებს არ მიიღებს'

/** Registered name of a Georgian number, '' when RS.ge doesn't know it. Needs the stored service user. */
async function georgianName(tin: string) {
  const c = storedCreds() ?? fail('ჯერ დაუკავშირდი RS.ge-ს')
  return rsge.nameFromTin(c, tin).catch((e: Error) => fail(e.message, 502))
}

/** Name of a Georgian taxpayer from RS.ge, with the stored service user. */
async function lookupName(tin: string, who = 'გადამხდელი') {
  const c = storedCreds() ?? fail('ჯერ დაუკავშირდი RS.ge-ს')
  const name = await rsge.nameFromTin(c, tin).catch((e: Error) => fail(e.message, 502))
  return name || fail(`${who} ამ ნომრით RS.ge-ზე ვერ მოიძებნა`)
}

/**
 * Connects a service user: checks it on RS.ge and, only if it passes, stores it together with the
 * seller and the reference lists. Leaving `sp` empty re-checks the stored password.
 */
export async function connectRs(body: { su?: string; sp?: string } | undefined, user: User) {
  requireAdmin(user)
  const prev = db.get().rs
  const su = str(body?.su)
  if (!su) fail('შეიყვანე სერვისის მომხმარებელი')
  const sp = str(body?.sp) || (su === prev.su ? prev.sp : '')
  if (!sp) fail('შეიყვანე სერვისის პაროლი')
  const c: RsCreds = { su, sp }
  const r = await rsge.check(c).catch((e: Error) => fail(e.message, 502))
  if (su !== prev.su || sp !== prev.sp) resetRsCache()
  db.set('rs', {
    ...db.get().rs,
    su,
    sp,
    sellerUnId: r.unId,
    sellerUserId: r.userId,
    sellerTin: r.tin,
    sellerName: r.name,
    checkedAt: nowIso(),
    units: r.units.length ? r.units : prev.units,
    transTypes: r.transTypes.length ? r.transTypes : prev.transTypes,
  })
  // A Georgian buyer saved earlier (possibly typed by hand) gets its name from RS.ge now.
  const rs = db.get().rs
  if (rs.buyerTin && !rs.buyerForeign) {
    const name = await rsge.nameFromTin(c, rs.buyerTin).catch(() => '')
    if (name && name !== rs.buyerName) db.set('rs', { ...db.get().rs, buyerName: name })
  }
  return { tin: r.tin, name: r.name }
}

/** Forgets the service user. Waybills already on RS.ge are not touched. */
export function disconnectRs(user: User) {
  requireAdmin(user)
  resetRsCache()
  db.set('rs', { ...db.get().rs, su: '', sp: '', sellerUnId: null, sellerUserId: null, sellerTin: '', sellerName: '', checkedAt: undefined })
}

/** Looks up a taxpayer's name by tax ID / personal number (get_name_from_tin). */
export async function rsNameFromTin(body: { tin?: string } | undefined, user: User) {
  requireAdmin(user)
  const tin = str(body?.tin)
  if (!/^\d{9}$|^\d{11}$/.test(tin)) fail('9 ან 11 ციფრი')
  return { name: await lookupName(tin) }
}

/**
 * Tag written into every waybill's COMMENT. If save_waybill's answer is lost, the next attempt
 * finds the waybill by this tag on RS.ge instead of creating a second one.
 */
const refTag = (shipmentId: string) => `HC:${shipmentId}`

/** Adds the shipment's tag to a payload that doesn't have it yet (built before tags existed). */
function withRef(p: RsWaybillPayload, shipmentId: string): RsWaybillPayload {
  const ref = refTag(shipmentId)
  return p.comment.includes(ref) ? p : { ...p, comment: [p.comment, ref].filter(Boolean).join('; ') }
}

/** Builds the waybill for a shipment from the admin's settings and the chosen route, driver and truck. */
function buildWaybill(d: Database, s: Pick<Shipment, 'id' | 'carrierId' | 'destinationId' | 'driverId' | 'truckId' | 'cargo' | 'quantity'>): RsWaybillPayload {
  const rs = d.rs
  const route = resolveRoute(d.carriers, s.carrierId, s.destinationId)
  const driver = d.drivers.find((x) => x.id === s.driverId)!
  const truck = d.trucks.find((x) => x.id === s.truckId)!
  const unitTxt = rs.unitId === RS_UNIT_OTHER ? rs.unitTxt : (rs.units.find((u) => u.id === rs.unitId)?.name ?? '')
  const amount = Math.round(s.quantity * rs.price * 100) / 100
  return {
    type: 2, // მიწოდება ტრანსპორტირებით
    buyerTin: rs.buyerTin,
    buyerForeign: rs.buyerForeign,
    buyerName: rs.buyerName,
    startAddress: route.start,
    endAddress: route.end,
    driverTin: driver.personalId.trim(),
    driverForeign: driver.citizenship === 'foreign',
    driverName: `${driver.firstName} ${driver.lastName}`,
    // RS.ge stores plates without dashes: AA-123-BB → AA123BB.
    carNumber: truck.plateNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    transId: rs.transId,
    transTxt: rs.transId === RS_TRANS_OTHER ? rs.transTxt : '',
    tranCostPayer: rs.tranCostPayer,
    transportCost: rs.transportCost,
    transporterTin: rs.transporterTin,
    receptionInfo: rs.receptionInfo,
    receiverInfo: rs.receiverInfo,
    // RS.ge has no trailer field, so the trailer goes into the comment.
    comment: [truck.trailerNumber && `მისაბმელი: ${truck.trailerNumber}`, rs.comment, refTag(s.id)].filter(Boolean).join('; '),
    goods: [{ name: s.cargo.description, unitId: rs.unitId, unitTxt, quantity: s.quantity, price: rs.price, amount, barCode: s.cargo.code, vatType: rs.vatType }],
  }
}

const rsNotReady = (d: Database) => {
  const missing = rsMissing(d.rs, { hasCreds: !!storedCreds() })
  return missing.length ? `RS.ge პარამეტრები არ არის შევსებული (${missing.join(', ')}) — მიმართე ადმინისტრატორს` : null
}

/* ---------------------------- Shipments ---------------------------- */

function patch(id: string, fn: (s: Shipment) => Partial<Shipment>, event?: Omit<ShipmentEvent, 'at'>) {
  db.updateShipment(id, (s) => ({ ...s, ...fn(s), events: event ? [...s.events, { at: nowIso(), ...event }] : s.events }))
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
    const notReady = rsNotReady(d)
    if (notReady) fail(notReady)
    const sid = uid('s')
    const s: Shipment = {
      id: sid,
      createdAt: nowIso(),
      createdBy: user.id,
      carrierId: input.carrierId,
      destinationId: input.destinationId,
      driverId: input.driverId,
      truckId: input.truckId,
      cargo,
      quantity,
      rsWaybill: buildWaybill(d, { ...input, id: sid, cargo, quantity }),
      status: 'uploading',
      rs: { status: 'pending' },
      sms: { status: 'pending' },
      events: [{ at: nowIso(), level: 'info', message: 'მოთხოვნილია ზედნადების ატვირთვა' }],
    }
    db.put('shipments', s)
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

  /** Completes (close_waybill) or cancels (ref_waybill) an uploaded waybill on RS.ge. */
  async finish(id: string, action: 'close' | 'cancel', user: User) {
    const s = get(id, user)
    if (user.role === 'report') fail('რეპორტ მომხმარებელს არ შეუძლია ამ მოქმედების შესრულება', 403)
    if (s.status !== 'uploaded' || s.waybillState) fail('ზედნადები არ არის აქტიური')
    if (!s.rsWaybillId) fail('ზედნადების RS.ge ID უცნობია — დაასრულე ან გააუქმე RS.ge-ს პორტალიდან')
    if (running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    running.add(id)
    try {
      if (action === 'close') await rsge.closeWaybill(s.rsWaybillId!, id)
      else await rsge.cancelWaybill(s.rsWaybillId!, id)
    } catch (e) {
      const msg = (e as Error).message
      patch(id, () => ({}), { level: 'error', message: msg })
      fail(msg, 502)
    } finally {
      running.delete(id)
    }
    patch(id, () => ({ waybillState: action === 'close' ? 'closed' : 'cancelled' }), {
      level: 'success',
      message: action === 'close' ? `ზედნადები №${s.waybillNumber} დასრულდა RS.ge-ზე` : `ზედნადები №${s.waybillNumber} გაუქმდა RS.ge-ზე`,
    })
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

  // 1. RS.ge — save the waybill (→ ID), then activate it (→ number)
  if (s.rs.status !== 'ok') {
    if (s.status === 'rs_failed') patch(id, () => ({}), { level: 'info', message: 'RS.ge-ზე ატვირთვის ხელახალი ცდა' })
    patch(id, () => ({ status: 'uploading', rs: { status: 'running' } }))
    try {
      const notReady = rsNotReady(d)
      if (notReady) throw new Error(notReady)
      // Shipments from before RS.ge settings existed get their waybill built now.
      const payload = withRef(s.rsWaybill ?? buildWaybill(d, s), id)
      let waybillId = s.rsWaybillId
      let number: string | undefined
      if (!waybillId && s.rsSaveAttemptedAt) {
        // An earlier save_waybill may have reached RS.ge without its answer reaching us. Look first;
        // if that isn't possible, stop rather than risk a second waybill for the same trip.
        const found = await rsge.findByRef(refTag(id), payload.buyerTin, new Date(s.rsSaveAttemptedAt), id).catch((e: Error) => {
          throw new Error(`ვერ შემოწმდა, შეინახა თუ არა წინა მცდელობამ ზედნადები RS.ge-ზე, ამიტომ თავიდან არ გაიგზავნა (${e.message}). სცადე ცოტა ხანში.`)
        })
        // Deleted (-1) or cancelled (-2) ones don't count: a new waybill is right then.
        if (found && found.status >= 0) {
          waybillId = found.id
          if (found.status >= 1 && found.number) number = found.number
          patch(id, () => ({ rsWaybill: payload, rsWaybillId: found.id, rsSaveAttemptedAt: undefined }), {
            level: 'info',
            message: `RS.ge-ზე ნაპოვნია წინა მცდელობით შენახული ზედნადები (ID ${found.id}) — ახალი არ შეიქმნა`,
          })
        }
      }
      if (!waybillId) {
        // Recorded before the call: from here on, a lost answer means "maybe saved".
        patch(id, () => ({ rsWaybill: payload, rsSaveAttemptedAt: nowIso() }))
        try {
          waybillId = await rsge.saveWaybill(payload, id)
        } catch (e) {
          // RS.ge answered with a refusal: nothing was created, so the next try needs no lookup.
          if (e instanceof IntegrationError && e.rejected) patch(id, () => ({ rsSaveAttemptedAt: undefined }))
          throw e
        }
        patch(id, () => ({ rsWaybillId: waybillId, rsSaveAttemptedAt: undefined }), { level: 'info', message: `RS.ge-ზე ზედნადები შეინახა (ID ${waybillId}), აქტივაცია…` })
      }
      number ??= await rsge.sendWaybill(waybillId, id)
      patch(
        id,
        () => ({ status: 'uploaded', waybillNumber: number, rs: { status: 'ok', at: nowIso() } }),
        { level: 'success', message: `RS.ge-მ დააბრუნა ზედნადები №${number}` },
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
    for (const k of ['latencyMs', 'smsFailRate'] as const) if (k in p && Number.isFinite(Number(p[k]))) next[k] = Number(p[k])
    db.set('settings', { ...db.get().settings, ...next })
  },
  clearLogs() {
    db.clearLogs()
  },
  reset(user: User) {
    requireAdmin(user)
    db.reset()
  },
}
