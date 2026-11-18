/**
 * Business rules. Every check that used to run in the browser runs here now, so a
 * client cannot skip it. Errors are thrown with the Georgian message shown to the user.
 */
import { canUseCarrier, resolveRoute, routeText, routeUsable } from '../src/lib/route.ts'
import { MAX_DEFER_MS, noTransport, RS_TRANS_OTHER, RS_UNIT_OTHER, rsMissing, rsUnits, shipmentWaybill, waybillDefaults } from '../src/lib/rs.ts'
import { active, nowIso, phoneKey, sameIds, shipmentUses, uid } from '../src/lib/util.ts'
import { SMS_FINAL } from '../src/lib/sms.ts'
import type { Carrier, CarrierRoute, Database, Driver, Product, RsListWaybill, RsRemoteWaybill, RsSettings, RsWaybillPayload, RouteGood, Shipment, ShipmentEvent, ShipmentItem, ShipmentWaybill, SmsDelivery, User, WaybillType } from '../src/types.ts'
import { IntegrationError } from './integrations.ts'
import { resetRsCache, rsDate, rsge, storedCreds, type RsCreds, type XmlGood } from './rsge.ts'
import { newReference, SENDER_RE, smsoffice, toDestination, type SmsCreds } from './smsoffice.ts'
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
const str = (v: unknown) => String(v ?? '').trim()

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

/** What a user is allowed to see: operators only get their own carriers' shipments. The RS.ge password and SMS key never leave the server. */
export function viewFor(user: User): Database {
  const raw = db.get()
  const d: Database = {
    ...raw,
    rs: { ...raw.rs, sp: '', spSet: !!raw.rs.sp, su: user.role === 'admin' ? raw.rs.su : '' },
    sms: { ...raw.sms, apiKey: '', apiKeySet: !!raw.sms.apiKey },
  }
  if (user.role !== 'operator') return d
  const mine = new Set(d.shipments.filter((s) => canUseCarrier(user, s.carrierId)).map((s) => s.id))
  return { ...d, shipments: d.shipments.filter((s) => mine.has(s.id)), logs: d.logs.filter((l) => l.shipmentId && mine.has(l.shipmentId)) }
}

/* ------------------------- Reference data ------------------------- */

export const REF_COLLECTIONS = ['carriers', 'routes', 'drivers', 'trucks', 'products', 'users'] as const
export type RefCollection = (typeof REF_COLLECTIONS)[number]
type RefRecord = Database[RefCollection][number]

const requireAdmin = (u: User) => u.role === 'admin' || fail('მოქმედება ხელმისაწვდომია მხოლოდ ადმინისტრატორისთვის', 403)

/** Active admins other than `id`. The last admin can't be deleted or demoted, so the system always has one. */
const otherAdmins = (id: string) => active(db.get().users).filter((u) => u.role === 'admin' && u.id !== id).length
const LAST_ADMIN = 'ეს ერთადერთი ადმინისტრატორია — ჯერ დანიშნე სხვა ადმინისტრატორი.'

function shipmentCount(col: RefCollection, id: string): number {
  return db.get().shipments.filter((s) => shipmentUses(s, col, id)).length
}

/** Removes a record, or soft-deletes it when shipments reference it so they keep showing it. */
function removeOrRetire(col: RefCollection, rec: RefRecord) {
  if (shipmentCount(col, rec.id) > 0) db.put(col, { ...rec, deletedAt: rec.deletedAt ?? nowIso() } as never)
  else db.remove(col, rec.id)
}

/** Removes the routes of a deleted carrier. */
function dropCarrierRoutes(carrierId: string) {
  for (const r of active(db.get().routes)) if (r.carrierId === carrierId) removeOrRetire('routes', r)
}

/** Most goods lines on one waybill. */
const MAX_GOODS = 50

/**
 * A route's goods lines, checked. Each is sent as written (filled from the product list or typed in):
 * RS.ge requires a name, bar code and unit on every line. Price ≥ 0, VAT 0/1/2. productId (the list
 * product it was filled from) is kept only while the bar code is still that product's.
 */
function parseRouteGoods(raw: unknown, prev: CarrierRoute | undefined): RouteGood[] {
  const d = db.get()
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  if (!list.length) fail('დაამატე მინიმუმ ერთი პროდუქტი')
  if (list.length > MAX_GOODS) fail(`ერთ მარშრუტზე მაქსიმუმ ${MAX_GOODS} პროდუქტია`)
  const units = rsUnits(d.rs)
  const ids = new Set<string>()
  const codes = new Set<string>()
  return list.map((x) => {
    // Line ids are kept, so shipments made from a line find it again on retries.
    let id = str(x?.id)
    if (!id || ids.has(id)) id = uid('g')
    ids.add(id)
    const name = str(x?.name)
    const barCode = str(x?.barCode)
    const unitId = num(x?.unitId, RS_UNIT_OTHER)
    const unitTxt = unitId === RS_UNIT_OTHER ? str(x?.unitTxt) : (units.find((u) => u.id === unitId)?.name ?? str(x?.unitTxt))
    const label = name || barCode || 'პროდუქტი'
    if (!barCode) fail(`„${label}“: ჩაწერე შტრიხკოდი — RS.ge მას ყველა პროდუქტზე ითხოვს`)
    if (!name) fail(`„${label}“: ჩაწერე დასახელება`)
    if (name.length > 250 || barCode.length > 50) fail(`„${label}“: დასახელება ან შტრიხკოდი ძალიან გრძელია`)
    // A unit RS.ge no longer lists is accepted only when the line already had it.
    const keptUnit = prev?.goods.some((y) => y.id === id && y.unitId === unitId)
    if (!units.some((u) => u.id === unitId) && !keptUnit) fail(`„${label}“: აირჩიე საზომი ერთეული`)
    if (!unitTxt) fail(`„${label}“: ჩაწერე ერთეულის დასახელება`)
    if (codes.has(barCode.toLowerCase())) fail(`„${label}“: ეს შტრიხკოდი მარშრუტზე ორჯერ არის`)
    codes.add(barCode.toLowerCase())
    const price = x?.price === '' || x?.price == null ? NaN : Number(x.price)
    if (!(price >= 0)) fail(`„${label}“: შეიყვანე ფასი (0 ან მეტი)`)
    const vatType = ([0, 1, 2] as const).find((v) => v === Number(x?.vatType))
    if (vatType == null) fail(`„${label}“: აირჩიე დაბეგვრის ტიპი`)
    const p = str(x?.productId) ? d.products.find((y) => y.id === str(x.productId) && y.barCode.toLowerCase() === barCode.toLowerCase()) : undefined
    // Excise goods: a code RS.ge lists (or the one the line already had, if RS.ge's list isn't loaded).
    const aId = Math.max(0, Math.trunc(num(x?.aId)))
    const akciz = aId ? d.rs.akciz?.find((a) => a.id === aId) : undefined
    const kept = aId ? prev?.goods.find((y) => y.id === id && y.aId === aId) : undefined
    if (aId && !akciz && !kept) fail(`„${label}“: აქციზის კოდი ვერ მოიძებნა — აირჩიე სიიდან`)
    const excise = aId ? { aId, aTitle: akciz ? `${akciz.code} · ${akciz.title}` : (kept!.aTitle ?? String(aId)) } : {}
    return { id, productId: p?.id ?? '', name, barCode, unitId, unitTxt, price: Math.round(price * 10000) / 10000, vatType: vatType!, ...excise }
  })
}

export const refs = {
  /** `token` is the caller's session: kept when admins change their own phone or role. */
  async save(col: RefCollection, record: RefRecord & { id?: string }, by: User, token?: string) {
    requireAdmin(by)
    const rec = { ...record, id: record.id || uid(col[0]) } as RefRecord
    const prev = (db.get()[col] as RefRecord[]).find((r) => r.id === rec.id)
    if (prev?.deletedAt) fail('ჩანაწერი წაშლილია')
    if (col === 'products') return productLock(() => saveProduct(rec as Product, prev as Product | undefined)).finally(() => void syncProducts())
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
      delete (u as User & { carrierId?: unknown }).carrierId
      if (u.role === 'operator') {
        const ids = Array.isArray(u.carrierIds) ? [...new Set(u.carrierIds.map(String))] : []
        const live = new Set(active(db.get().carriers).map((c) => c.id))
        // A carrier deleted since the form was opened is dropped silently if others remain.
        u.carrierIds = ids.filter((id) => live.has(id))
        if (!u.carrierIds.length) fail('ოპერატორს უნდა ჰქონდეს მინიმუმ ერთი კარიერი')
      } else delete u.carrierIds
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
        const name = await rsName(x.personalId)
        if (x.citizenship === 'GE' && !name) fail('ეს პირადი ნომერი RS.ge-ს რეესტრში ვერ მოიძებნა')
        if (x.citizenship === 'foreign' && name) fail('ეს პირადი ნომერი საქართველოს რეესტრშია — აირჩიე „საქართველოს მოქალაქე“')
      }
    }
    if (col === 'carriers') {
      const c = rec as Carrier
      Object.assign(c, { name: str(c.name).trim(), startAddress: str(c.startAddress).trim() })
      delete (c as Carrier & { destinations?: unknown }).destinations
      if (!c.name) fail('შეიყვანე კარიერის დასახელება')
      if (!c.startAddress) fail('შეიყვანე დაწყების მისამართი')
    }
    if (col === 'routes') {
      const r = rec as CarrierRoute
      const d = db.get()
      const was = prev as CarrierRoute | undefined
      // Only these fields are kept.
      Object.assign(r, {
        carrierId: str(r.carrierId),
        endAddress: str(r.endAddress).trim(),
        scaleId: str(r.scaleId).trim(),
        goods: parseRouteGoods(r.goods, was),
        ...(await routeWaybill(r, was)),
      })
      for (const k of Object.keys(r)) if (!['id', 'carrierId', 'endAddress', 'scaleId', 'goods', 'waybillType', 'buyerTin', 'buyerName', 'buyerForeign'].includes(k)) delete (r as unknown as Record<string, unknown>)[k]
      if (r.waybillType == null) delete r.waybillType
      if (!r.buyerTin) for (const k of ['buyerTin', 'buyerName', 'buyerForeign'] as const) delete r[k]
      const carrier = d.carriers.find((c) => c.id === r.carrierId)
      if (!carrier || carrier.deletedAt) fail('აირჩიე კარიერი')
      if (!r.endAddress) fail('შეიყვანე დასრულების მისამართი')
      if (!r.scaleId) fail('შეიყვანე სასწორის ID')
      // The same addresses may be opened again with other products.
      const codes = (x: CarrierRoute) => x.goods.map((g) => g.barCode.toLowerCase())
      const same = (x: CarrierRoute) =>
        x.id !== r.id && x.carrierId === r.carrierId && sameIds(codes(x), codes(r)) && x.endAddress.trim().toLowerCase() === r.endAddress.toLowerCase()
      if (active(d.routes).some(same)) fail('ეს მარშრუტი უკვე არსებობს')
    }
    db.put(col, rec as never)
    if (revokeSessions) db.sessions.deleteForUser(rec.id, rec.id === by.id ? token : undefined)
    return rec
  },

  /** Deletes a record. If shipments reference it, it is soft-deleted so reports keep showing it. */
  async remove(col: RefCollection, id: string, by: User) {
    requireAdmin(by)
    if (col === 'products') return productLock(() => removeProduct(id)).finally(() => void syncProducts())
    if (col === 'users') {
      const u = db.get().users.find((x) => x.id === id)
      if (u?.role === 'admin' && !u.deletedAt && !otherAdmins(id)) fail(`წაშლა შეუძლებელია: ${LAST_ADMIN}`)
    }
    if (col === 'carriers') {
      const n = active(db.get().users).filter((x) => x.role === 'operator' && x.carrierIds?.includes(id)).length
      if (n) fail(`წაშლა შეუძლებელია: მიბმულია ${n} ოპერატორთან — ჯერ მოხსენი ეს კარიერი მათ ანგარიშებში.`)
    }
    const rec = (db.get()[col] as RefRecord[]).find((r) => r.id === id)
    if (!rec) fail('ჩანაწერი ვერ მოიძებნა', 404)
    removeOrRetire(col, rec!)
    if (col === 'carriers') dropCarrierRoutes(id)
    if (col === 'users') db.sessions.deleteForUser(id)
  },
}

/** A waybill type sent by a client: 1, 2, 3 or 5; anything else is undefined. */
const waybillType = (v: unknown): WaybillType | undefined => ([1, 2, 3, 5] as const).find((t) => t === Number(v))

/**
 * A route's own waybill type and buyer (both optional: missing ones come from the RS.ge settings).
 * The buyer is looked up on RS.ge like the settings' one. Checked against what RS.ge refuses:
 * a buyer is needed on every type but შიდა გადაზიდვა (-1004), and may not be the seller (-1047).
 */
async function routeWaybill(r: CarrierRoute, prev: CarrierRoute | undefined): Promise<Pick<CarrierRoute, 'waybillType' | 'buyerTin' | 'buyerName' | 'buyerForeign'>> {
  const rs = db.get().rs
  const type = str(r.waybillType) ? (waybillType(r.waybillType) ?? fail('აირჩიე ზედნადების ტიპი')) : undefined
  const tin = type === 1 ? '' : str(r.buyerTin)
  if (tin && rs.sellerTin && tin === rs.sellerTin) fail('მყიდველი გამყიდველს ემთხვევა — ასეთი ზედნადები მხოლოდ შიდა გადაზიდვაა')
  const buyer = tin ? await resolveBuyer(tin, str(r.buyerName), { buyerTin: prev?.buyerTin ?? '', buyerName: prev?.buyerName ?? '', buyerForeign: !!prev?.buyerForeign }) : { buyerTin: '', buyerName: '', buyerForeign: false }
  const effective = waybillDefaults(rs, { waybillType: type, ...buyer })
  if (effective.type !== 1 && !effective.buyerTin) fail('ამ ტიპის ზედნადებს მყიდველი სჭირდება — ჩაწერე აქ ან RS.ge-ს პარამეტრებში')
  return { waybillType: type, ...buyer }
}

/* ------------------------------ Products ------------------------------ */

/*
 * The product list is a copy of the connected taxpayer's product list on RS.ge, and nothing else:
 * - adding, editing and deleting go to RS.ge first and change the copy only when RS.ge accepted;
 * - every sync makes the copy equal to RS.ge's list (added, changed and deleted there → same here);
 * - another service user (another taxpayer) or no service user at all empties the copy at once,
 *   so the previous account's products never stay pickable, and the sync then fills it again.
 * Products that shipments used are retired (hidden), not deleted, so those shipments keep showing them.
 */

/** Product changes and syncs run one at a time, so a sync never undoes a change it didn't see. */
let productChain: Promise<unknown> = Promise.resolve()
function productLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = productChain.then(fn, fn)
  productChain = run.catch(() => {})
  return run
}

const productCreds = () => storedCreds() ?? fail('ჯერ დაუკავშირდი RS.ge-ს — პროდუქტები RS.ge-ზე ინახება')

/** Hides every product: they belonged to an account that is no longer connected. */
function dropAllProducts() {
  for (const p of active(db.get().products)) removeOrRetire('products', p)
}

async function saveProduct(input: Product, prev: Product | undefined): Promise<Product> {
  productCreds()
  const unitId = Number(input.unitId)
  const aId = Math.max(0, Math.trunc(num(input.aId)))
  const price = input.price == null || String(input.price).trim() === '' ? undefined : Number(String(input.price).replace(',', '.'))
  const p: Product = {
    id: input.id,
    name: str(input.name),
    barCode: str(input.barCode),
    unitId,
    unitTxt: unitId === RS_UNIT_OTHER ? str(input.unitTxt) : (rsUnits(db.get().rs).find((u) => u.id === unitId)?.name ?? ''),
    aId,
    ...(price !== undefined && { price: Math.round(price * 10000) / 10000 }),
    vatType: ([0, 1, 2] as const).find((v) => v === Number(input.vatType)) ?? 0,
  }
  if (price !== undefined && !(price >= 0)) fail('ფასი უნდა იყოს 0 ან მეტი')
  // An excise code RS.ge lists (or the one the product already has, if the list isn't loaded).
  if (aId && aId !== (prev?.aId ?? 0) && !db.get().rs.akciz?.some((a) => a.id === aId)) fail('აქციზის კოდი ვერ მოიძებნა — აირჩიე სიიდან')
  if (!p.name) fail('შეიყვანე პროდუქტის დასახელება')
  if (!p.barCode) fail('შეიყვანე შტრიხკოდი')
  // RS.ge knows a product only by its bar code: a new code would be a different product there.
  if (prev && prev.barCode !== p.barCode) fail('შტრიხკოდის შეცვლა შეუძლებელია — წაშალე ეს პროდუქტი და დაამატე ახალი')
  if (!(unitId > 0) || !p.unitTxt) fail(unitId === RS_UNIT_OTHER ? '„სხვა“ ერთეულისთვის შეიყვანე ერთეულის დასახელება' : 'აირჩიე საზომი ერთეული')
  const key = p.barCode.toLowerCase()
  if (active(db.get().products).some((x) => x.id !== p.id && x.barCode.toLowerCase() === key)) fail('ამ შტრიხკოდით პროდუქტი უკვე არსებობს')
  // Only price or VAT type changed: those are kept here only, RS.ge has nothing to update.
  if (prev && prev.name === p.name && prev.unitId === p.unitId && prev.unitTxt === p.unitTxt && (prev.aId ?? 0) === aId) {
    db.put('products', p)
    return p
  }
  // A code already on RS.ge (added on the portal, not synced yet) is overwritten there, as on the portal.
  await rsge.saveBarCode({ ...p, aId }).catch((e: Error) => fail(e.message, 502))
  // RS.ge answers "saved" even when it drops the code, so only what it reads back counts.
  const got = await rsge.barCode(p.barCode).catch((e: Error) => fail(`RS.ge-მ შენახვა დაადასტურა, მაგრამ შემოწმება ვერ მოხერხდა: ${e.message}`, 502))
  if (!got) fail(`RS.ge-მ შტრიხკოდი „${p.barCode}“ არ შეინახა — სავარაუდოდ ის უკვე სხვა გადამხდელს აქვს რეგისტრირებული. გამოიყენე სხვა, უნიკალური შტრიხკოდი.`, 502)
  if (got!.name !== p.name || got!.unitId !== p.unitId) fail('RS.ge-მ ცვლილება არ შეინახა — სცადე თავიდან ან შეცვალე RS.ge-ს პორტალზე.', 502)
  if (got!.aId !== aId) fail('RS.ge-მ აქციზის კოდი არ შეინახა — სცადე თავიდან ან შეცვალე RS.ge-ს პორტალზე.', 502)
  db.put('products', p)
  return p
}

async function removeProduct(id: string) {
  const p = db.get().products.find((x) => x.id === id) ?? fail('ჩანაწერი ვერ მოიძებნა', 404)
  if (p.deletedAt) return
  productCreds()
  await rsge.deleteBarCode(p.barCode).catch((e: Error) => fail(e.message, 502))
  removeOrRetire('products', p)
}

/** The product list is read again on page open only when the last read is older than this. */
const PRODUCTS_FRESH_MS = 30_000
let productSyncQueued: Promise<void> | null = null

/**
 * Reads RS.ge's product list and makes ours equal to it. Never throws; a failure is stored in
 * rs.productsSyncError. Calls made while a sync is already running get a fresh one after it, so
 * a sync started for the previous account is always followed by one for the current account.
 */
export function syncProducts(): Promise<void> {
  if (productSyncQueued) return productSyncQueued
  const p = productLock(async () => {
    productSyncQueued = null
    await runProductSync()
  })
  productSyncQueued = p
  return p
}

async function runProductSync() {
  if (!storedCreds()) return dropAllProducts()
  const su = db.get().rs.su
  const sameUser = () => db.get().rs.su === su
  try {
    const remote = new Map((await rsge.barCodes()).map((x) => [x.barCode, x]))
    // The account changed while RS.ge answered: this list is the old account's. The next sync reads the new one.
    if (!sameUser()) return
    for (const p of active(db.get().products)) {
      const r = remote.get(p.barCode)
      remote.delete(p.barCode)
      if (!r) removeOrRetire('products', p)
      // Price and VAT type are ours only: kept as they are.
      else if ((r.name || p.name) !== p.name || r.unitId !== p.unitId || r.unitTxt !== p.unitTxt || r.aId !== (p.aId ?? 0))
        db.put('products', { ...p, name: r.name || p.name, unitId: r.unitId, unitTxt: r.unitTxt, aId: r.aId })
    }
    // New on RS.ge. A retired product with the same bar code comes back under its old id, so the
    // shipments that used it point at the live product again.
    for (const r of remote.values()) {
      const old = db.get().products.findLast((x) => x.deletedAt && x.barCode === r.barCode)
      // A product coming back keeps the price and VAT type it had here.
      db.put('products', { ...(old && { price: old.price, vatType: old.vatType }), id: old?.id ?? uid('p'), name: r.name || r.barCode, barCode: r.barCode, unitId: r.unitId, unitTxt: r.unitTxt, aId: r.aId })
    }
    db.set('rs', { ...db.get().rs, productsSyncedAt: nowIso(), productsSyncError: undefined })
    // The excise codes, when connecting couldn't load them (or connected before they were kept).
    if (!db.get().rs.akciz?.length) {
      const akciz = await rsge.akciz().catch(() => [])
      if (akciz.length && sameUser()) db.set('rs', { ...db.get().rs, akciz })
    }
  } catch (e) {
    const msg = (e as Error).message
    console.error('[rs-products]', msg)
    if (sameUser()) db.set('rs', { ...db.get().rs, productsSyncError: msg })
  }
}

/**
 * Asked by the products tab and the new-shipment page when they open (only if the last read is
 * older than PRODUCTS_FRESH_MS), and by the admin's "refresh" button (`force`).
 */
export async function syncProductsNow(body: { force?: boolean } | undefined, user: User) {
  const force = !!body?.force
  if (force) requireAdmin(user)
  if (!storedCreds()) return force ? fail('ჯერ დაუკავშირდი RS.ge-ს') : undefined
  const last = db.get().rs.productsSyncedAt
  if (!force && !db.get().rs.productsSyncError && last && Date.now() - Date.parse(last) < PRODUCTS_FRESH_MS) return
  await syncProducts()
  const err = db.get().rs.productsSyncError
  if (force && err) fail(err, 502)
}

/* ------------------------------ RS.ge ------------------------------ */

const num = (v: unknown, fallback = 0) => (v === '' || v == null || !Number.isFinite(Number(v)) ? fallback : Number(v))

/**
 * Saves the waybill defaults (buyer, transport…). The service user is not part of this: it is
 * set only by connectRs, after RS.ge accepted it. With no buyer the waybill is შიდა გადაზიდვა (the
 * buyer is the seller). A buyer RS.ge knows always gets RS.ge's name; for one it doesn't, the typed
 * name is kept and the number is sent unchecked.
 */
export async function saveRsSettings(v: Partial<RsSettings>, user: User) {
  requireAdmin(user)
  const prev = db.get().rs
  const next: RsSettings = {
    ...prev,
    ...(await resolveBuyer(str(v.buyerTin), str(v.buyerName), prev)),
    transporterTin: str(v.transporterTin),
    transId: num(v.transId, 1),
    transTxt: str(v.transTxt),
    tranCostPayer: Number(v.tranCostPayer) === 1 ? 1 : 2,
    transportCost: num(v.transportCost),
    quantity: num(v.quantity),
    receptionInfo: str(v.receptionInfo),
    receiverInfo: str(v.receiverInfo),
    comment: str(v.comment),
  }
  delete next.spSet
  // Left over from before v19 (unit) and v23 (price, VAT type): now set on each route's goods lines.
  for (const k of ['unitId', 'unitTxt', 'price', 'vatType']) delete (next as unknown as Record<string, unknown>)[k]
  if (next.transporterTin && !/^\d{9}$|^\d{11}$/.test(next.transporterTin)) fail('გადამზიდავის ს/ნ უნდა იყოს 9 ან 11 ციფრი')
  if (next.transportCost < 0) fail('თანხა არ შეიძლება იყოს უარყოფითი')
  if (next.quantity < 0) fail('რაოდენობა არ შეიძლება იყოს უარყოფითი')
  if (next.transId === RS_TRANS_OTHER && !next.transTxt) fail('„სხვა“ ტრანსპორტისთვის შეიყვანე ტიპის დასახელება')
  db.set('rs', next)
}

/**
 * The buyer as it is stored: RS.ge's name when it knows the number, else the typed one (required).
 * If RS.ge can't be asked, an unchanged number keeps what was saved, so other settings still save.
 */
type Buyer = Pick<RsSettings, 'buyerTin' | 'buyerName' | 'buyerForeign'>

async function resolveBuyer(tin: string, typedName: string, prev: Buyer): Promise<Buyer> {
  if (!tin) return { buyerTin: '', buyerName: '', buyerForeign: false }
  if (tin.length > 50) fail('მყიდველის ნომერი ძალიან გრძელია')
  let rsKnown: string
  try {
    rsKnown = await rsName(tin)
  } catch (e) {
    if (tin === prev.buyerTin && prev.buyerName) return { buyerTin: tin, buyerName: prev.buyerForeign ? typedName || prev.buyerName : prev.buyerName, buyerForeign: prev.buyerForeign }
    throw e
  }
  if (rsKnown) return { buyerTin: tin, buyerName: rsKnown, buyerForeign: false }
  return { buyerTin: tin, buyerName: typedName || fail('მყიდველი RS.ge-ზე ვერ მოიძებნა — შეიყვანე დასახელება'), buyerForeign: true }
}

/** Name RS.ge has for the number, '' when it doesn't know it. Needs the stored service user. */
async function rsName(tin: string) {
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
  if (!/^[^:]+:(\d{9}|\d{11})$/.test(su)) fail('სერვისის მომხმარებელი უნდა იყოს ფორმატით სახელი:კოდი (კოდი — 9 ან 11 ციფრი)')
  const sp = str(body?.sp) || (su === prev.su ? prev.sp : '')
  if (!sp) fail('შეიყვანე სერვისის პაროლი')
  const c: RsCreds = { su, sp }
  const r = await rsge.check(c).catch((e: Error) => fail(e.message, 502))
  if (su !== prev.su || sp !== prev.sp) resetRsCache()
  const sameUser = su === prev.su && r.unId === prev.sellerUnId
  // Another taxpayer: the previous one's products go at once; the sync below loads this one's.
  if (su !== prev.su) await productLock(async () => dropAllProducts())
  db.set('rs', {
    ...db.get().rs,
    // Another taxpayer's waybills: the background sync starts over.
    ...(!sameUser && { syncedTo: undefined, syncError: undefined }),
    ...(su !== prev.su && { productsSyncedAt: undefined, productsSyncError: undefined }),
    su,
    sp,
    sellerUnId: r.unId,
    sellerUserId: r.userId,
    sellerTin: r.tin,
    sellerName: r.name,
    checkedAt: nowIso(),
    units: r.units.length ? r.units : prev.units,
    transTypes: r.transTypes.length ? r.transTypes : prev.transTypes,
    akciz: r.akciz.length ? r.akciz : prev.akciz,
  })
  void syncProducts()
  return { tin: r.tin, name: r.name }
}

/** Forgets the service user. Waybills already on RS.ge are not touched. */
export async function disconnectRs(user: User) {
  requireAdmin(user)
  resetRsCache()
  db.set('rs', { ...db.get().rs, su: '', sp: '', sellerUnId: null, sellerUserId: null, sellerTin: '', sellerName: '', checkedAt: undefined, syncedTo: undefined, syncError: undefined, productsSyncedAt: undefined, productsSyncError: undefined })
  // No account, no products: the sync empties the list (it runs after any change in progress).
  return syncProducts()
}

/** Looks up a taxpayer's name by tax ID / personal number (get_name_from_tin). */
export async function rsNameFromTin(body: { tin?: string; foreign?: boolean } | undefined, user: User) {
  // Operators pick a shipment's buyer too.
  if (user.role === 'report') fail('მოქმედება ხელმისაწვდომი არ არის', 403)
  const tin = str(body?.tin)
  // A foreign number has no fixed format, and RS.ge not knowing it is an answer, not an error ('').
  if (body?.foreign) return { name: tin && tin.length <= 50 ? await rsName(tin) : fail('არასწორი ნომერი') }
  if (!/^\d{9}$|^\d{11}$/.test(tin)) fail('9 ან 11 ციფრი')
  return { name: await lookupName(tin) }
}

/* ------------------------------ SMS ------------------------------ */

/** The stored smsoffice.ge account, or null when SMS isn't set up. */
const smsCreds = (): SmsCreds | null => {
  const { apiKey, sender } = db.get().sms
  return apiKey && sender ? { apiKey, sender } : null
}

/**
 * Saves the smsoffice.ge account after checking the key (getBalance). An empty key keeps the stored
 * one. The sender can't be checked without sending: the test SMS does that.
 */
export async function connectSms(body: { apiKey?: string; sender?: string } | undefined, user: User) {
  requireAdmin(user)
  const prev = db.get().sms
  const sender = str(body?.sender)
  if (!sender) fail('შეიყვანე გამგზავნის სახელი')
  if (!SENDER_RE.test(sender)) fail('გამგზავნის სახელი: მაქსიმუმ 11 ლათინური ასო, ციფრი, „-“ ან „.“')
  const apiKey = str(body?.apiKey) || prev.apiKey
  if (!apiKey) fail('შეიყვანე API გასაღები')
  const balance = await smsoffice.balance({ apiKey }).catch((e: Error) => fail(e.message, 502))
  db.set('sms', { apiKey, sender, balance, checkedAt: nowIso() })
  return { balance }
}

/** Forgets the smsoffice.ge account: drivers get no SMS until it is set up again. */
export function disconnectSms(user: User) {
  requireAdmin(user)
  db.set('sms', { apiKey: '', sender: '' })
}

/** Sends a test SMS with the stored account, so the admin sees the sender name work. */
export async function testSms(body: { phone?: string } | undefined, user: User) {
  requireAdmin(user)
  const c = smsCreds() ?? fail('ჯერ შეინახე smsoffice.ge-ს API გასაღები და გამგზავნი')
  const destination = toDestination(str(body?.phone)) ?? fail('შეიყვანე მობილურის ნომერი ფორმატით 5XX XX XX XX')
  await smsoffice.send(c, destination, 'HC Portal: სატესტო შეტყობინება. SMS მუშაობს.', newReference()).catch((e: Error) => fail(e.message, 502))
  // The test used one message: show the new balance (not fatal if this fails).
  const balance = await smsoffice.balance(c).catch(() => undefined)
  if (balance != null && db.get().sms.apiKey === c.apiKey) db.set('sms', { ...db.get().sms, balance, checkedAt: nowIso() })
}

/**
 * Tag written into every waybill's COMMENT. If save_waybill's answer is lost, the next attempt
 * finds the waybill by this tag on RS.ge instead of creating a second one.
 */
const refTag = (shipmentId: string) => `HC:${shipmentId}`

type WaybillSource = Pick<Shipment, 'id' | 'routeId' | 'driverId' | 'truckId' | 'items' | 'waybill'>

/**
 * Builds the waybill for a shipment from its waybill options (type, buyer, transport details), the
 * chosen route, driver, truck and goods lines, and the admin's transport settings. Each line is read
 * from the route as it is now, so a retry picks up a fix to it; a line gone from the route is sent as
 * it was when the shipment was made.
 */
function buildWaybill(d: Database, s: WaybillSource): RsWaybillPayload {
  const rs = d.rs
  const route = resolveRoute(d, s.routeId)
  const w = shipmentWaybill(s, rs, route.route)
  const driver = d.drivers.find((x) => x.id === s.driverId)
  const truck = d.trucks.find((x) => x.id === s.truckId)
  const moving = !noTransport(w.type)
  const goods = s.items.map((i) => {
    // The route's line as it is now (a fix the admin made after a refusal applies), else the item's snapshot.
    const g = (i.lineId && route.route?.goods.find((x) => x.id === i.lineId)) || i
    return {
      name: g.name,
      barCode: g.barCode,
      unitId: g.unitId,
      unitTxt: g.unitTxt,
      quantity: i.quantity,
      price: g.price,
      amount: Math.round(i.quantity * g.price * 100) / 100,
      vatType: g.vatType,
      aId: g.aId ?? 0,
      ...(i.quantityExt && { quantityExt: i.quantityExt }),
    }
  })
  return {
    type: w.type,
    // შიდა გადაზიდვა: the buyer is the seller (with any other type RS.ge refuses buyer = seller: -1047).
    ...(w.type === 1 ? { buyerTin: rs.sellerTin, buyerForeign: false, buyerName: rs.sellerName } : { buyerTin: w.buyerTin, buyerForeign: w.buyerForeign, buyerName: w.buyerName }),
    startAddress: route.start,
    // Without transport RS.ge wants the end to be the start (-1036).
    endAddress: moving ? route.end : route.start,
    driverTin: moving && driver ? driver.personalId.trim() : '',
    driverForeign: moving && driver?.citizenship === 'foreign',
    driverName: moving && driver ? `${driver.firstName} ${driver.lastName}` : '',
    // RS.ge stores plates without dashes: AA-123-BB → AA123BB.
    carNumber: moving && truck ? truck.plateNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '',
    transId: rs.transId,
    transTxt: rs.transId === RS_TRANS_OTHER ? rs.transTxt : '',
    tranCostPayer: w.tranCostPayer,
    transportCost: moving ? w.transportCost : 0,
    transporterTin: moving ? rs.transporterTin : '',
    receptionInfo: w.receptionInfo,
    receiverInfo: w.receiverInfo,
    // RS.ge has no trailer field, so the trailer goes into the comment.
    comment: [moving && truck?.trailerNumber && `მისაბმელი: ${truck.trailerNumber}`, w.comment, refTag(s.id)].filter(Boolean).join('; '),
    goods,
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
  if (!s || (user && !canUseCarrier(user, s.carrierId))) return fail('რეისი ვერ მოიძებნა', 404)
  return s
}

const noReport = (user: User) => user.role === 'report' && fail('რეპორტ მომხმარებელს არ შეუძლია ამ მოქმედების შესრულება', 403)

const running = new Set<string>()

/** A goods line as the client sends it: one of the route's lines, its quantity and the optional additional quantity. */
export type NewShipmentItem = { lineId: string; quantity: number; quantityExt?: number }

/** Waybill options as the client sends them; anything left out comes from the route and the settings. */
export type WaybillInput = Partial<Omit<ShipmentWaybill, 'beginAt'>> & { beginAt?: string | null }

export interface NewShipmentInput {
  carrierId: string
  routeId: string
  driverId: string
  truckId: string
  items: NewShipmentItem[]
  waybill?: WaybillInput
  /** Save on RS.ge without activating. */
  draft?: boolean
}

/**
 * The goods lines of a new shipment: lines of the route (each at most once), with a quantity > 0.
 * Everything but the quantity comes from the route, never from the request.
 */
function parseItems(raw: unknown, route: CarrierRoute): ShipmentItem[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  if (!list.length) fail('რეისზე მინიმუმ ერთი პროდუქტი უნდა იყოს')
  const seen = new Set<string>()
  return list.map((x) => {
    const lineId = str(x?.lineId)
    const { id: _id, ...g } = route.goods.find((x) => x.id === lineId) ?? fail('მარშრუტის პროდუქტები შეიცვალა — განაახლე გვერდი')
    if (seen.has(lineId)) fail(`„${g.name}“ ორჯერ არის`)
    seen.add(lineId)
    const quantity = Math.round(num(x?.quantity) * 1000) / 1000
    if (!(quantity > 0)) fail(`„${g.name}“: რაოდენობა უნდა იყოს 0-ზე მეტი`)
    const quantityExt = Math.round(num(x?.quantityExt) * 1000) / 1000
    if (quantityExt < 0) fail(`„${g.name}“: დამატებითი რაოდენობა არ შეიძლება იყოს უარყოფითი`)
    return { lineId, ...g, quantity, ...(quantityExt > 0 && { quantityExt }) }
  })
}

const MAX_INFO = 250

/**
 * A shipment's waybill options: what the client chose, else the route's, else the settings'. The buyer
 * is looked up on RS.ge (its name wins) unless it is the one already resolved for the route or settings.
 * `keepBegin`: a correction keeps the start RS.ge already has.
 */
async function parseWaybillInput(raw: WaybillInput | undefined, route: CarrierRoute, prev?: ShipmentWaybill): Promise<ShipmentWaybill> {
  const rs = db.get().rs
  const base = prev ?? waybillDefaults(rs, route)
  const x = raw ?? {}
  const type = x.type == null ? base.type : (waybillType(x.type) ?? fail('აირჩიე ზედნადების ტიპი'))
  let buyer: Buyer = { buyerTin: '', buyerName: '', buyerForeign: false }
  if (type !== 1) {
    // The route's (or settings') buyer when the type alone was changed and none is typed.
    const fallback = base.buyerTin ? base : waybillDefaults(rs, { ...route, waybillType: 2 })
    const tin = x.buyerTin == null ? fallback.buyerTin : str(x.buyerTin)
    if (!tin) fail('ამ ტიპის ზედნადებს მყიდველი სჭირდება — ჩაწერე მყიდველის საიდენტიფიკაციო ნომერი')
    if (tin.length > 50) fail('მყიდველის ნომერი ძალიან გრძელია')
    if (rs.sellerTin && tin === rs.sellerTin) fail('მყიდველი გამყიდველს ემთხვევა — ასეთი ზედნადები მხოლოდ შიდა გადაზიდვაა')
    const known = tin === fallback.buyerTin && fallback.buyerName && (!str(x.buyerName) || str(x.buyerName) === fallback.buyerName)
    buyer = known ? { buyerTin: tin, buyerName: fallback.buyerName, buyerForeign: fallback.buyerForeign } : await resolveBuyer(tin, str(x.buyerName), fallback)
  }
  let beginAt: string | undefined
  if (x.beginAt) {
    const t = Date.parse(x.beginAt)
    if (!Number.isFinite(t)) fail('ტრანსპორტირების დაწყების დრო არასწორია')
    if (t < Date.now() - 5 * 60_000) fail('ტრანსპორტირების დაწყება წარსულში ვერ იქნება')
    if (t > Date.now() + MAX_DEFER_MS - 5 * 60_000) fail('RS.ge ტრანსპორტირების დაწყებას მაქსიმუმ 3 დღით გადადების საშუალებას იძლევა')
    // Within a couple of minutes is "now".
    if (t > Date.now() + 2 * 60_000) beginAt = new Date(t).toISOString()
  } else if (x.beginAt === undefined && prev?.beginAt && Date.parse(prev.beginAt) > Date.now()) beginAt = prev.beginAt
  const transportCost = x.transportCost == null ? base.transportCost : num(x.transportCost, NaN)
  if (!(transportCost >= 0)) fail('ტრანსპორტირების ღირებულება უნდა იყოს 0 ან მეტი')
  const text = (v: unknown, fallback: string, label: string) => {
    const t = v == null ? fallback : str(v)
    if (t.length > MAX_INFO) fail(`${label}: მაქსიმუმ ${MAX_INFO} სიმბოლო`)
    return t
  }
  return {
    type,
    ...buyer,
    ...(beginAt && { beginAt }),
    transportCost: Math.round(transportCost * 100) / 100,
    tranCostPayer: x.tranCostPayer == null ? base.tranCostPayer : Number(x.tranCostPayer) === 1 ? 1 : 2,
    receptionInfo: text(x.receptionInfo, base.receptionInfo, 'მიმწოდებლის ინფორმაცია'),
    receiverInfo: text(x.receiverInfo, base.receiverInfo, 'მიმღების ინფორმაცია'),
    comment: text(x.comment, base.comment, 'კომენტარი'),
  }
}

/** Route, driver, truck, goods and waybill options of a new or edited shipment, checked. */
async function parseShipment(body: Partial<NewShipmentInput>, user: User, prev?: Shipment) {
  const input = { carrierId: str(body.carrierId), routeId: str(body.routeId), driverId: str(body.driverId), truckId: str(body.truckId) }
  if (!canUseCarrier(user, input.carrierId)) fail('ოპერატორს შეუძლია მხოლოდ მისთვის მინიჭებული კარიერების გამოყენება', 403)
  const d = db.get()
  const carrier = d.carriers.find((c) => c.id === input.carrierId)
  if (!carrier || carrier.deletedAt) fail('კარიერი ვერ მოიძებნა ან წაშლილია')
  const picked = d.routes.find((x) => x.id === input.routeId && x.carrierId === input.carrierId)
  if (!picked || !routeUsable(d.carriers, picked)) fail('მარშრუტი ვერ მოიძებნა ან წაშლილია')
  const waybill = await parseWaybillInput(body.waybill, picked!, prev?.waybill)
  // A driver or truck kept from before may have been deleted since; a new pick must be live.
  const usable = <T extends { id: string; deletedAt?: string }>(xs: T[], id: string, was?: string) => xs.some((x) => x.id === id && (!x.deletedAt || id === was))
  if (noTransport(waybill.type)) {
    input.driverId = ''
    input.truckId = ''
  } else {
    if (!usable(d.drivers, input.driverId, prev?.driverId)) fail('მძღოლი ვერ მოიძებნა ან წაშლილია')
    if (!usable(d.trucks, input.truckId, prev?.truckId)) fail('მანქანა ვერ მოიძებნა ან წაშლილია')
  }
  const items = parseItems(body.items, picked!)
  const quantity = Math.round(items.reduce((a, i) => a + i.quantity, 0) * 1000) / 1000
  return { ...input, items, quantity, waybill }
}

/** The shipment's items with what was sent to RS.ge (a product may have been renamed since the shipment was made). */
function sentItems(s: Shipment, payload: RsWaybillPayload): ShipmentItem[] {
  return s.items.map((i, k) => {
    const g = payload.goods[k]
    const line = i.lineId ? resolveRoute(db.get(), s.routeId).route?.goods.find((x) => x.id === i.lineId) : undefined
    return { ...i, name: g.name, barCode: g.barCode, unitId: g.unitId, unitTxt: g.unitTxt, price: g.price, vatType: g.vatType, aId: g.aId, aTitle: line ? line.aTitle : i.aTitle }
  })
}

/** Start of transport written at save time: the planned one when it is still ahead, else now. */
const plannedBegin = (s: Pick<Shipment, 'waybill'>) => {
  const t = s.waybill?.beginAt ? Date.parse(s.waybill.beginAt) : NaN
  return Number.isFinite(t) && t > Date.now() ? new Date(t) : undefined
}

/**
 * The goods rows that turn the waybill RS.ge has (`remote`) into `goods`: rows are matched by bar code
 * and keep their RS.ge ID (updated in place); new lines get none (added); remote rows left over are
 * deleted. Overwriting rows by ID is what a correction on the portal does.
 */
function rowsFor(goods: RsWaybillPayload['goods'], remote: RsRemoteWaybill): XmlGood[] {
  const left = remote.goods.filter((g) => g.id)
  const rows: XmlGood[] = goods.map((g) => {
    const k = left.findIndex((r) => r.barCode.toLowerCase() === g.barCode.toLowerCase())
    const match = k >= 0 ? left.splice(k, 1)[0] : undefined
    return { ...g, ...(match && { rsId: match.id }) }
  })
  for (const r of left)
    rows.push({ rsId: r.id, deleted: true, name: r.name, barCode: r.barCode, unitId: r.unitId ?? RS_UNIT_OTHER, unitTxt: r.unitTxt, quantity: r.quantity, price: r.price, amount: r.amount, vatType: (r.vatType ?? 0) as 0 | 1 | 2, aId: r.aId ?? 0 })
  return rows
}

/** What changed between two versions of a shipment, for its history. */
function describeEdit(d: Database, a: Shipment, b: Pick<Shipment, 'routeId' | 'driverId' | 'truckId' | 'items' | 'quantity' | 'waybill'>) {
  const out: string[] = []
  const name = (id: string) => {
    const x = d.drivers.find((y) => y.id === id)
    return x ? `${x.firstName} ${x.lastName}` : '—'
  }
  const plate = (id: string) => d.trucks.find((y) => y.id === id)?.plateNumber ?? '—'
  if (a.routeId !== b.routeId) out.push(`მარშრუტი: ${routeText(resolveRoute(d, b.routeId))}`)
  if (a.driverId !== b.driverId) out.push(`მძღოლი: ${name(a.driverId)} → ${name(b.driverId)}`)
  if (a.truckId !== b.truckId) out.push(`მანქანა: ${plate(a.truckId)} → ${plate(b.truckId)}`)
  if (a.quantity !== b.quantity || a.items.length !== b.items.length) out.push(`რაოდენობა: ${a.quantity} → ${b.quantity}`)
  const wa = a.waybill
  const wb = b.waybill
  if (wa && wb) {
    if (wa.type !== wb.type) out.push('ზედნადების ტიპი შეიცვალა')
    if (wa.buyerTin !== wb.buyerTin) out.push(`მყიდველი: ${wb.buyerName || wb.buyerTin || 'გამყიდველი'}`)
    if ((wa.beginAt ?? '') !== (wb.beginAt ?? '')) out.push(`დაწყება: ${wb.beginAt ? tbilisiTime(wb.beginAt) : 'გააქტიურებისას'}`)
  }
  return out
}

/** `YYYY-MM-DD HH:MM` in Georgian time, for history messages. */
const tbilisiTime = (iso: string) => rsDate(new Date(iso)).replace('T', ' ').slice(0, 16)

/** A planned start of transport sent with an activation; '' or missing = now. */
function parseBegin(v: unknown): string | undefined {
  const raw = str(v)
  if (!raw) return undefined
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) fail('ტრანსპორტირების დაწყების დრო არასწორია')
  if (t < Date.now() - 5 * 60_000) fail('ტრანსპორტირების დაწყება წარსულში ვერ იქნება')
  if (t > Date.now() + MAX_DEFER_MS - 5 * 60_000) fail('RS.ge ტრანსპორტირების დაწყებას მაქსიმუმ 3 დღით გადადების საშუალებას იძლევა')
  return t > Date.now() + 2 * 60_000 ? new Date(t).toISOString() : undefined
}

/** A delivery date sent with "complete": not in the future (RS.ge -1017). Missing = now. */
function parseDelivered(v: unknown): Date | undefined {
  const raw = str(v)
  if (!raw) return undefined
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) fail('მიწოდების თარიღი არასწორია')
  if (t > Date.now() + 60_000) fail('მიწოდების თარიღი მომავალში ვერ იქნება')
  return new Date(Math.min(t, Date.now()))
}

export const shipments = {
  /** Creates the record and starts the upload pipeline in the background. */
  async create(body: Partial<NewShipmentInput>, user: User): Promise<string> {
    if (user.role === 'report') fail('რეპორტ მომხმარებელს არ შეუძლია რეისის შექმნა', 403)
    const d = db.get()
    const notReady = rsNotReady(d)
    if (notReady) fail(notReady)
    const x = await parseShipment(body, user)
    const sid = uid('s')
    const draft = !!body.draft
    const s: Shipment = {
      id: sid,
      createdAt: nowIso(),
      createdBy: user.id,
      ...x,
      ...(draft && { draft }),
      rsWaybill: buildWaybill(db.get(), { ...x, id: sid }),
      status: 'uploading',
      rs: { status: 'pending' },
      sms: { status: 'pending' },
      events: [{ at: nowIso(), level: 'info', message: draft ? 'მოთხოვნილია ზედნადების შენახვა RS.ge-ზე (გააქტიურების გარეშე)' : 'მოთხოვნილია ზედნადების ატვირთვა' }],
    }
    db.put('shipments', s)
    void shipments.run(s.id)
    return s.id
  },

  /** Runs (or resumes) the pipeline: RS.ge → SMS. Safe to call again for retries. */
  async run(id: string, user?: User) {
    get(id, user)
    if (user) noReport(user)
    if (running.has(id)) return
    running.add(id)
    try {
      await runPipeline(id)
    } finally {
      running.delete(id)
    }
  },

  /**
   * Activates a waybill saved as a draft: from now, or from `beginAt` (up to 3 days ahead). The
   * pipeline then activates it and texts the driver.
   */
  async activate(id: string, body: { beginAt?: string } | undefined, user: User) {
    const s = get(id, user)
    noReport(user)
    if (s.status !== 'saved' || s.waybillState) fail('ზედნადები არ არის შენახულ (გაუაქტიურებელ) მდგომარეობაში')
    if (running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    const beginAt = parseBegin(body?.beginAt)
    patch(
      id,
      (x) => ({ draft: undefined, status: 'uploading', rs: { status: 'pending' }, waybill: { ...shipmentWaybill(x, db.get().rs, resolveRoute(db.get(), x.routeId).route), beginAt } }),
      { level: 'info', message: beginAt ? `მოთხოვნილია გააქტიურება, ტრანსპორტირების დაწყება ${tbilisiTime(beginAt)}` : 'მოთხოვნილია გააქტიურება' },
    )
    void shipments.run(id)
  },

  /**
   * Changes a shipment. Before anything reached RS.ge only the record changes (retry sends it). A
   * draft on RS.ge is overwritten; an active waybill is corrected (კორექტირება), as on the portal: its
   * type and start stay, the rest follows the new route, driver, truck, goods and options. The driver
   * is texted again when the driver or truck changed.
   */
  async edit(id: string, body: Partial<NewShipmentInput>, user: User) {
    const s = get(id, user)
    noReport(user)
    if (running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    if (s.waybillState) fail(s.waybillState === 'closed' ? 'დასრულებულ ზედნადებს ვერ შეცვლი' : 'გაუქმებულ ზედნადებს ვერ შეცვლი')
    if (s.invoiceId) fail('ანგარიშ-ფაქტურაზე მიბმულ ზედნადებს ვერ შეცვლი')
    if (s.status === 'uploading') fail('რეისი ახლა იტვირთება — სცადე ცოტა ხანში')
    if (s.status === 'rs_failed' && !s.rsWaybillId && s.rsSaveAttemptedAt)
      fail('უცნობია, შეინახა თუ არა წინა მცდელობამ ზედნადები RS.ge-ზე — ჯერ დააჭირე „ხელახლა ცდას“')
    const active = s.status === 'uploaded'
    const onRs = !!s.rsWaybillId
    const x = await parseShipment({ ...body, carrierId: body.carrierId ?? s.carrierId }, user, s)
    if (active && s.waybill && x.waybill.type !== s.waybill.type) fail('აქტიურ ზედნადებზე ტიპს ვერ შეცვლი (RS.ge)')
    // An active waybill keeps the start RS.ge has.
    if (active) {
      delete x.waybill.beginAt
      if (s.waybill?.beginAt) x.waybill.beginAt = s.waybill.beginAt
    }
    const next: Shipment = { ...s, ...x }
    const payload = buildWaybill(db.get(), next)
    const changes = describeEdit(db.get(), s, x)
    if (!onRs) {
      patch(id, () => ({ ...x, rsWaybill: payload }), { level: 'info', message: `რეისი შეიცვალა${changes.length ? ` — ${changes.join('; ')}` : ''}` })
      return
    }
    if (!storedCreds()) fail('RS.ge არ არის დაკავშირებული')
    running.add(id)
    let remote: RsRemoteWaybill | null = null
    try {
      const now = await rsge.getWaybill(s.rsWaybillId!, id).catch((e: Error) => fail(e.message, 502))
      if (active && now.status !== 1) fail(`RS.ge-ზე ზედნადები ${RS_STATUS_TEXT[now.status] ?? now.status}-ა — შეცვლა შეუძლებელია`)
      if (!active && now.status !== 0) fail('RS.ge-ზე ზედნადები უკვე აღარ არის შენახულ მდგომარეობაში — განაახლე გვერდი')
      const begin = active ? (now.beginAt ? new Date(now.beginAt) : new Date()) : (plannedBegin(next) ?? new Date())
      await rsge
        .saveWaybill(payload, id, { id: s.rsWaybillId!, status: active ? 1 : 0, beginDate: rsDate(begin), goods: rowsFor(payload.goods, now) })
        .catch((e: Error) => fail(e.message, 502))
      remote = await rsge.getWaybill(s.rsWaybillId!, id).catch(() => null)
    } finally {
      running.delete(id)
    }
    const message = active ? `ზედნადები №${s.waybillNumber} დაკორექტირდა RS.ge-ზე` : 'RS.ge-ზე შენახული ზედნადები განახლდა'
    patch(id, (y) => ({ ...x, rsWaybill: payload, items: sentItems({ ...y, ...x }, payload), ...(remote && { rsRemote: remote }) }), {
      level: 'success',
      message: `${message}${changes.length ? ` — ${changes.join('; ')}` : ''}`,
    })
    // The new driver (or the same one, with another truck) gets the waybill by SMS.
    if (active && x.driverId && (x.driverId !== s.driverId || x.truckId !== s.truckId)) {
      patch(id, () => ({ sms: { status: 'pending' } }))
      void shipments.run(id)
    }
  },

  async retrySms(id: string, user: User) {
    const s = get(id, user)
    noReport(user)
    // Sent again only when it failed or the phone never got it, so a double click can't text the driver twice.
    if (s.sms.status === 'ok' && !smsUndelivered(s)) fail('SMS უკვე გაიგზავნა')
    if (!s.waybillNumber || running.has(id)) return
    running.add(id)
    try {
      await sendSms(id)
    } finally {
      running.delete(id)
    }
  },

  /**
   * Completes (close_waybill, or close_waybill_vd with the delivery date), cancels (ref_waybill) or,
   * for a draft, deletes (del_waybill) the waybill on RS.ge. RS.ge also cancels a completed waybill, so
   * cancel is allowed after close. The waybill is read back after the call: the page shows the result
   * at once, and a refusal because it was already done on the rs.ge portal counts as done.
   */
  async finish(id: string, action: 'close' | 'cancel' | 'delete', user: User, body?: { deliveredAt?: string }) {
    const s = get(id, user)
    noReport(user)
    if (action === 'delete') {
      if (s.status !== 'saved' || s.waybillState) fail('წაიშლება მხოლოდ შენახული (გაუაქტიურებელი) ზედნადები')
    } else if (s.status !== 'uploaded') fail('ზედნადები ჯერ არ არის გააქტიურებული')
    if (action === 'close' && s.waybillState) fail(s.waybillState === 'closed' ? 'ზედნადები უკვე დასრულებულია' : 'გაუქმებულ ზედნადებს ვერ დაასრულებ')
    if (action === 'cancel' && s.waybillState === 'cancelled') fail('ზედნადები უკვე გაუქმებულია')
    if (action === 'cancel' && s.invoiceId) fail('ანგარიშ-ფაქტურაზე მიბმულ ზედნადებს RS.ge ვერ გააუქმებს — ჯერ გააუქმე ფაქტურა RS.ge-ს პორტალზე')
    if (!s.rsWaybillId) fail('ზედნადების RS.ge ID უცნობია — დაასრულე ან გააუქმე RS.ge-ს პორტალიდან')
    if (running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    const delivered = action === 'close' ? parseDelivered(body?.deliveredAt) : undefined
    const target = action === 'close' ? 'closed' : 'cancelled'
    let error: Error | undefined
    let w: RsRemoteWaybill | null = null
    running.add(id)
    try {
      try {
        if (action === 'close') await rsge.closeWaybill(s.rsWaybillId!, id, delivered)
        else if (action === 'cancel') await rsge.cancelWaybill(s.rsWaybillId!, id)
        else await rsge.deleteWaybill(s.rsWaybillId!, id)
      } catch (e) {
        error = e as Error
      }
      w = await rsge.getWaybill(s.rsWaybillId!, id).catch(() => null)
    } finally {
      running.delete(id)
    }
    if (error && (!w || stateOf(w.status) !== target)) {
      patch(id, () => ({}), { level: 'error', message: error.message })
      if (w) applyRemote(id, w)
      fail(error.message, 502)
    }
    if (!error)
      patch(id, () => ({ waybillState: target }), {
        level: 'success',
        message:
          action === 'close'
            ? `ზედნადები №${s.waybillNumber} დასრულდა RS.ge-ზე`
            : action === 'cancel'
              ? `ზედნადები №${s.waybillNumber} გაუქმდა RS.ge-ზე`
              : `RS.ge-ზე შენახული ზედნადები (ID ${s.rsWaybillId}) წაიშალა`,
      })
    if (w) applyRemote(id, w)
  },

  /**
   * Writes a tax invoice (ანგარიშ-ფაქტურა) from the waybill on RS.ge. Not for შიდა გადაზიდვა (no sale).
   * If RS.ge refuses because one exists already (written on the portal), that one is recorded.
   */
  async invoice(id: string, user: User) {
    const s = get(id, user)
    noReport(user)
    if (s.status !== 'uploaded' || s.waybillState === 'cancelled') fail('ანგარიშ-ფაქტურა იწერება მხოლოდ აქტიურ ან დასრულებულ ზედნადებზე')
    if ((s.rsWaybill?.type ?? 1) === 1) fail('შიდა გადაზიდვაზე ანგარიშ-ფაქტურა არ იწერება')
    if (s.invoiceId) fail(`ანგარიშ-ფაქტურა უკვე გამოწერილია (ID ${s.invoiceId})`)
    if (!s.rsWaybillId) fail('ზედნადების RS.ge ID უცნობია')
    // RS.ge refuses it (-3009) until the planned start of transport has come.
    const begin = s.rsRemote?.beginAt ?? s.waybill?.beginAt
    if (begin && Date.parse(begin) > Date.now()) fail(`ანგარიშ-ფაქტურა გამოიწერება ტრანსპორტირების დაწყების შემდეგ (${tbilisiTime(begin)})`)
    if (running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    running.add(id)
    try {
      let inv: number | undefined
      let error: Error | undefined
      try {
        inv = await rsge.saveInvoice(s.rsWaybillId!, id)
      } catch (e) {
        error = e as Error
      }
      const w = await rsge.getWaybill(s.rsWaybillId!, id).catch(() => null)
      inv ??= w?.invoiceId
      if (!inv) {
        patch(id, () => ({}), { level: 'error', message: error?.message ?? 'ანგარიშ-ფაქტურა ვერ გამოიწერა' })
        fail(error?.message ?? 'ანგარიშ-ფაქტურა ვერ გამოიწერა', 502)
      }
      patch(id, () => ({ invoiceId: inv, ...(w && { rsRemote: w }) }), { level: 'success', message: `ანგარიშ-ფაქტურა გამოიწერა RS.ge-ზე (ID ${inv})` })
      return { invoiceId: inv }
    } finally {
      running.delete(id)
    }
  },

  /**
   * Reads the shipment's waybill from RS.ge and records it (opening a shipment calls this). Answers
   * fast when it was read moments ago, so reopening the page doesn't call RS.ge every time.
   */
  async refreshFromRs(id: string, user: User) {
    const s = get(id, user)
    if ((s.status !== 'uploaded' && s.status !== 'saved') || !s.rsWaybillId) return
    if (s.rsRemote && Date.now() - Date.parse(s.rsRemote.checkedAt) < REFRESH_FRESH_MS) return
    if (!storedCreds()) fail('RS.ge არ არის დაკავშირებული — ნაჩვენებია ბოლოს ნანახი მონაცემები', 409)
    let p = reading.get(id)
    if (!p) {
      p = rsge.getWaybill(s.rsWaybillId!, id, 'page').then((w) => applyRemote(id, w))
      reading.set(id, p)
      void p.catch(() => {}).finally(() => reading.delete(id))
    }
    await p.catch((e: Error) => fail(e.message, 502))
  },

  /** Asks smsoffice.ge whether the driver got the SMS (opening a shipment calls this). */
  async refreshSms(id: string, user: User) {
    get(id, user)
    await checkDelivery(id).catch((e: Error) => fail(e.message, 502))
  },

  /** On server start: finish pipelines interrupted by a restart. */
  resumeAll() {
    db.get()
      .shipments.filter((s) => s.status === 'uploading' || s.sms.status === 'running' || (s.status === 'uploaded' && s.sms.status === 'pending'))
      .forEach((s) => void shipments.run(s.id))
  },
}

/* ------------------------- RS.ge read-back ------------------------- */

/** A waybill read less than this long ago is not read again when the shipment is opened. */
const REFRESH_FRESH_MS = 15_000
const reading = new Map<string, Promise<void>>()

const RS_STATUS_TEXT: Record<number, string> = { 0: 'შენახული', 1: 'აქტიური', 2: 'დასრულებული', 8: 'გადამზიდავთან გადაგზავნილი', [-1]: 'წაშლილი', [-2]: 'გაუქმებული' }

/** waybillState for an RS.ge status: completed → closed, deleted or cancelled → cancelled. */
const stateOf = (status: number): Shipment['waybillState'] => (status === 2 ? 'closed' : status < 0 ? 'cancelled' : undefined)

const plateKey = (v: string) => v.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

/**
 * Records the waybill as RS.ge reported it. RS.ge wins over what was sent: a waybill completed,
 * cancelled or corrected on the rs.ge portal is shown that way here, with an event saying what changed.
 * A draft activated on the portal becomes uploaded here, and its driver is texted.
 */
function applyRemote(id: string, w: RsRemoteWaybill) {
  // A pipeline or close/cancel in progress records its own outcome; the next read catches up.
  if (running.has(id)) return
  const s = db.get().shipments.find((x) => x.id === id)
  if (!s || (s.status !== 'uploaded' && s.status !== 'saved')) return
  const invoice = { invoiceId: w.invoiceId ?? s.invoiceId }
  if (s.status === 'saved') {
    if (w.status !== 0 && w.number && w.status > 0) {
      patch(id, () => ({ ...invoice, rsRemote: w, status: 'uploaded', draft: undefined, waybillNumber: w.number, waybillState: stateOf(w.status), rs: { status: 'ok', at: nowIso() } }), {
        level: 'success',
        message: `ზედნადები №${w.number} გააქტიურდა RS.ge-ზე`,
      })
      void shipments.run(id)
    } else if (w.status < 0 && !s.waybillState) patch(id, () => ({ rsRemote: w, waybillState: 'cancelled' }), { level: 'info', message: 'RS.ge-ზე შენახული ზედნადები წაიშალა' })
    else patch(id, () => ({ rsRemote: w }))
    return
  }
  // Compared with the last reading, or with what was sent before the first one.
  const sent = s.rsWaybill
  const was = s.rsRemote ?? {
    carNumber: sent?.carNumber ?? '',
    driverTin: sent?.driverTin ?? '',
    driverName: sent?.driverName ?? '',
    startAddress: sent?.startAddress ?? '',
    endAddress: sent?.endAddress ?? '',
    quantity: s.quantity,
    fullAmount: Math.round((sent?.goods ?? []).reduce((a, g) => a + g.amount, 0) * 100) / 100,
    invoiceId: undefined,
  }
  const changes: string[] = []
  const state = stateOf(w.status)
  if (state !== s.waybillState) changes.push(`სტატუსი: ${RS_STATUS_TEXT[w.status] ?? w.status}`)
  if (plateKey(w.carNumber) !== plateKey(was.carNumber)) changes.push(`მანქანა: ${was.carNumber || '—'} → ${w.carNumber || '—'}`)
  if (w.driverTin !== was.driverTin) changes.push(`მძღოლი: ${was.driverName || was.driverTin} → ${w.driverName || w.driverTin}`)
  if (w.startAddress.trim() !== was.startAddress.trim()) changes.push(`დაწყების მისამართი: ${w.startAddress || '—'}`)
  if (w.endAddress.trim() !== was.endAddress.trim()) changes.push(`დასრულების მისამართი: ${w.endAddress || '—'}`)
  if (w.quantity !== was.quantity) changes.push(`რაოდენობა: ${was.quantity} → ${w.quantity}`)
  if (Math.abs(w.fullAmount - was.fullAmount) >= 0.005) changes.push(`თანხა: ${was.fullAmount.toFixed(2)} → ${w.fullAmount.toFixed(2)} ₾`)
  if (w.invoiceId && w.invoiceId !== s.invoiceId) changes.push(`ანგარიშ-ფაქტურა: ID ${w.invoiceId}`)
  patch(
    id,
    (x) => ({ ...invoice, rsRemote: w, waybillState: state, waybillNumber: w.number || x.waybillNumber }),
    changes.length ? { level: 'info', message: `RS.ge-ზე შეიცვალა — ${changes.join('; ')}` } : undefined,
  )
}

/** Minutes between background syncs (RS_SYNC_MINUTES, default 5; 0 turns it off). */
const SYNC_MS = Math.max(0, Number(process.env.RS_SYNC_MINUTES ?? 5) || 0) * 60_000
/** The furthest back one sync reads. Older changes still show up when the shipment is opened. */
const SYNC_MAX_BACK_MS = 30 * 86400_000
/** Each sync re-reads this much of the previous window, against clock differences between the servers. */
const SYNC_OVERLAP_MS = 5 * 60_000
let syncing: Promise<void> | null = null

/**
 * Background sync: asks RS.ge which waybills changed since the last sync (get_waybills_v1) and
 * re-reads the ones that belong to uploaded shipments or drafts. A failed sync leaves the cursor
 * where it was, so the next one reads the same changes again.
 */
export function syncRs(): Promise<void> {
  syncing ??= runSync().finally(() => (syncing = null))
  return syncing
}

async function runSync() {
  const start = db.get().rs
  if (!storedCreds()) return
  const stillSameUser = () => db.get().rs.su === start.su && db.get().rs.sellerUnId === start.sellerUnId
  const now = Date.now()
  try {
    const tracked = db.get().shipments.filter((s) => (s.status === 'uploaded' || s.status === 'saved') && s.rsWaybillId)
    const byWaybill = new Map(tracked.map((s) => [s.rsWaybillId!, s.id]))
    // First sync: from the oldest tracked shipment, so changes made before syncing existed count too.
    const cursor = start.syncedTo ? Date.parse(start.syncedTo) - SYNC_OVERLAP_MS : tracked.reduce((m, s) => Math.min(m, Date.parse(s.createdAt)), now)
    const from = new Date(Math.max(now - SYNC_MAX_BACK_MS, cursor))
    const to = new Date(now)
    const ids = new Set<number>()
    if (tracked.length) for (const w of await rsge.changed(from, to)) if (byWaybill.has(w.id)) ids.add(w.id)
    for (const wid of ids) {
      const sid = byWaybill.get(wid)!
      applyRemote(sid, await rsge.getWaybill(wid, sid, 'sync'))
    }
    if (stillSameUser()) db.set('rs', { ...db.get().rs, syncedTo: to.toISOString(), syncError: undefined })
  } catch (e) {
    const msg = (e as Error).message
    console.error('[rs-sync]', msg)
    if (stillSameUser() && db.get().rs.syncError !== msg) db.set('rs', { ...db.get().rs, syncError: msg })
  }
}

/** Starts the background sync (server start). */
export function startRsSync() {
  if (!SYNC_MS) return
  const both = () => void syncRs().then(() => syncProducts())
  setTimeout(both, 15_000).unref()
  setInterval(both, SYNC_MS).unref()
}

/** "Sync now" from the settings page. */
export async function syncRsNow(user: User) {
  requireAdmin(user)
  if (!storedCreds()) fail('ჯერ დაუკავშირდი RS.ge-ს')
  await syncRs()
  const err = db.get().rs.syncError
  if (err) fail(err, 502)
}

async function runPipeline(id: string) {
  let s = get(id)
  const d = db.get()

  // 1. RS.ge — save the waybill (→ ID), then activate it (→ number); a draft stops after saving.
  if (s.rs.status !== 'ok') {
    if (s.status === 'rs_failed') patch(id, () => ({}), { level: 'info', message: 'RS.ge-ზე ატვირთვის ხელახალი ცდა' })
    patch(id, () => ({ status: 'uploading', rs: { status: 'running' } }))
    try {
      const notReady = rsNotReady(d)
      if (notReady) throw new Error(notReady)
      let waybillId = s.rsWaybillId
      let done: Activated | null = null
      if (!waybillId && s.rsSaveAttemptedAt) {
        // An earlier save_waybill may have reached RS.ge without its answer reaching us. Look first;
        // if that isn't possible, stop rather than risk a second waybill for the same trip.
        const found = await rsge.findByRef(refTag(id), new Date(s.rsSaveAttemptedAt), id).catch((e: Error) => {
          throw new Error(`ვერ შემოწმდა, შეინახა თუ არა წინა მცდელობამ ზედნადები RS.ge-ზე, ამიტომ თავიდან არ გაიგზავნა (${e.message}). სცადე ცოტა ხანში.`)
        })
        // Deleted (-1) or cancelled (-2) ones don't count: a new waybill is right then.
        if (found && found.status >= 0) {
          waybillId = found.id
          if (found.status >= 1 && found.number) done = { number: found.number, status: found.status }
          patch(id, () => ({ rsWaybillId: found.id, rsSaveAttemptedAt: undefined }), {
            level: 'info',
            message: `RS.ge-ზე ნაპოვნია წინა მცდელობით შენახული ზედნადები (ID ${found.id}) — ახალი არ შეიქმნა`,
          })
        }
      }
      if (!waybillId) waybillId = await saveNew(id)
      if (!done && get(id).draft) {
        patch(id, () => ({ status: 'saved', rs: { status: 'ok', at: nowIso() } }), { level: 'success', message: `ზედნადები შეინახა RS.ge-ზე (ID ${waybillId}) — გასააქტიურებელია` })
        return
      }
      done ??= await activate(id, waybillId)
      if (!done) {
        // The saved draft was deleted on the rs.ge portal before it was activated.
        patch(id, () => ({ rsWaybillId: undefined }), { level: 'info', message: `RS.ge-ზე შენახული ზედნადები (ID ${waybillId}) წაშლილია — იქმნება ახალი` })
        waybillId = await saveNew(id)
        done = await activate(id, waybillId)
        if (!done) throw new Error(`RS.ge-ზე ზედნადები (ID ${waybillId}) წაიშალა გააქტიურებამდე`)
      }
      const { number, status } = done
      const state = stateOf(status)
      patch(
        id,
        () => ({ status: 'uploaded', draft: undefined, waybillNumber: number, waybillState: state, rs: { status: 'ok', at: nowIso() } }),
        { level: 'success', message: `RS.ge-მ დააბრუნა ზედნადები №${number}${state ? ` (RS.ge-ზე უკვე ${RS_STATUS_TEXT[status]})` : ''}` },
      )
    } catch (e) {
      const msg = (e as Error).message
      patch(id, () => ({ status: 'rs_failed', rs: { status: 'failed', error: msg, at: nowIso() } }), { level: 'error', message: msg })
      return
    }
  }

  // 2. SMS to driver (a waybill without transport has none)
  s = get(id)
  if (s.status !== 'uploaded') return
  if (!s.driverId) {
    if (s.sms.status === 'pending') patch(id, () => ({ sms: { status: 'skipped' } }))
    return
  }
  if (s.sms.status !== 'ok') await sendSms(id)
}

/**
 * Saves a new waybill for the shipment and returns its ID. Built from the current settings and
 * reference data: nothing exists on RS.ge yet, so whatever the admin fixed after a refusal applies.
 */
async function saveNew(id: string): Promise<number> {
  const s = get(id)
  const payload = buildWaybill(db.get(), s)
  // Recorded before the call: from here on, a lost answer means "maybe saved".
  // The items keep what was sent (a product may have been renamed since the shipment was created).
  patch(id, (x) => ({ rsWaybill: payload, items: sentItems(x, payload), rsSaveAttemptedAt: nowIso() }))
  let waybillId: number
  try {
    waybillId = await rsge.saveWaybill(payload, id, { beginDate: rsDate(plannedBegin(s)) })
  } catch (e) {
    // RS.ge answered with a refusal: nothing was created, so the next try needs no lookup.
    if (e instanceof IntegrationError && e.rejected) patch(id, () => ({ rsSaveAttemptedAt: undefined }))
    throw e
  }
  patch(id, () => ({ rsWaybillId: waybillId, rsSaveAttemptedAt: undefined }), { level: 'info', message: `RS.ge-ზე ზედნადები შეინახა (ID ${waybillId})${s.draft ? '' : ', აქტივაცია…'}` })
  return waybillId
}

type Activated = { number: string; status: number }

/**
 * Activates a saved waybill, from the planned start when it is still ahead. When that fails, RS.ge is
 * asked how the waybill stands: if the answer to an earlier activation was lost, it is already active
 * and send_waybill only says -1, which would otherwise fail every retry. null: the draft was deleted,
 * a new waybill is needed.
 */
async function activate(id: string, waybillId: number): Promise<Activated | null> {
  try {
    return { number: await rsge.sendWaybill(waybillId, id, plannedBegin(get(id))), status: 1 }
  } catch (e) {
    const w = await rsge.getWaybill(waybillId, id).catch(() => null)
    if (w && w.status !== 0 && w.number) return { number: w.number, status: w.status }
    if (w?.status === -1) return null
    throw e
  }
}

/* ------------------------- RS.ge registry ------------------------- */

/** The registry reads at most this far back in one go (each 72 hours is one RS.ge call). */
const LIST_MAX_MS = 31 * 86400_000

/** Shipment of each RS.ge waybill ID, among the shipments the user may see. */
function shipmentByWaybill(user: User) {
  return new Map(
    db
      .get()
      .shipments.filter((s) => s.rsWaybillId && canUseCarrier(user, s.carrierId))
      .map((s) => [s.rsWaybillId!, s.id]),
  )
}

const listViewer = (user: User) => (user.role === 'operator' ? fail('RS.ge-ს ზედნადებების რეესტრი ხელმისაწვდომია ადმინისტრატორისთვის და რეპორტ მომხმარებლისთვის', 403) : undefined)

export const rsWaybills = {
  /** Issued or received waybills created in [from, to], as RS.ge lists them, each tied to its shipment when it is one. */
  async list(q: { side?: string; from?: string; to?: string }, user: User): Promise<RsListWaybill[]> {
    listViewer(user)
    if (!storedCreds()) fail('ჯერ დაუკავშირდი RS.ge-ს')
    const side = q.side === 'received' ? 'received' : 'issued'
    const to = q.to ? new Date(Math.min(Date.parse(q.to), Date.now() + 60_000)) : new Date()
    const from = q.from ? new Date(Date.parse(q.from)) : new Date(to.getTime() - 3 * 86400_000)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) fail('პერიოდი არასწორია')
    if (to.getTime() - from.getTime() > LIST_MAX_MS) fail('პერიოდი მაქსიმუმ 31 დღეა')
    const rows = await rsge.list(side, from, to).catch((e: Error) => fail(e.message, 502))
    const mine = shipmentByWaybill(user)
    return rows.map((r) => ({ ...r, ...(mine.has(r.id) && { shipmentId: mine.get(r.id) }) }))
  },

  /** One waybill as RS.ge has it now. Operators only see their own shipments' waybills. */
  async get(waybillId: number, user: User): Promise<RsRemoteWaybill & { shipmentId?: string }> {
    const sid = shipmentByWaybill(user).get(waybillId)
    if (user.role === 'operator' && !sid) fail('ზედნადები ვერ მოიძებნა', 404)
    if (!storedCreds()) fail('ჯერ დაუკავშირდი RS.ge-ს')
    const w = await rsge.getWaybill(waybillId, sid, 'page').catch((e: Error) => fail(e.message, 502))
    if (sid) applyRemote(sid, w)
    return { ...w, ...(sid && { shipmentId: sid }) }
  },

  /**
   * An action on any waybill of the taxpayer, as on the portal (admin only). One that belongs to a
   * shipment goes through the shipment, so its record and history follow.
   */
  async act(waybillId: number, action: string, body: { beginAt?: string; deliveredAt?: string } | undefined, user: User) {
    requireAdmin(user)
    if (!storedCreds()) fail('ჯერ დაუკავშირდი RS.ge-ს')
    const sid = shipmentByWaybill(user).get(waybillId)
    if (sid) {
      if (action === 'close' || action === 'cancel' || action === 'delete') await shipments.finish(sid, action, user, body)
      else if (action === 'activate') await shipments.activate(sid, body, user)
      else if (action === 'invoice') await shipments.invoice(sid, user)
    }
    if (!sid || !['close', 'cancel', 'delete', 'activate', 'invoice'].includes(action)) {
      const call = (p: Promise<unknown>) => p.catch((e: Error) => fail(e.message, 502))
      if (action === 'close') await call(rsge.closeWaybill(waybillId, undefined, parseDelivered(body?.deliveredAt)))
      else if (action === 'cancel') await call(rsge.cancelWaybill(waybillId, undefined))
      else if (action === 'delete') await call(rsge.deleteWaybill(waybillId, undefined))
      else if (action === 'activate') {
        const begin = parseBegin(body?.beginAt)
        await call(rsge.sendWaybill(waybillId, undefined, begin ? new Date(begin) : undefined))
      } else if (action === 'invoice') await call(rsge.saveInvoice(waybillId, undefined))
      else if (action === 'confirm' || action === 'reject') await call(rsge.answer(waybillId, action === 'confirm'))
      else fail('უცნობი მოქმედება', 404)
    }
    return rsWaybills.get(waybillId, user)
  },
}

const smsUndelivered = (s: Shipment) => s.sms.delivery === 'Undelivered' || s.sms.delivery === 'Expired'

async function sendSms(id: string) {
  const s = get(id)
  const d = db.get()
  const driver = d.drivers.find((x) => x.id === s.driverId)
  if (!driver) return void patch(id, () => ({ sms: { status: 'skipped' } }))
  const route = resolveRoute(d, s.routeId)
  const truck = d.trucks.find((x) => x.id === s.truckId)
  const start = s.waybill?.beginAt && Date.parse(s.waybill.beginAt) > Date.now() ? ` დაწყება: ${rsDate(new Date(s.waybill.beginAt)).slice(11, 16)}.` : ''
  const text = `ზედნადები №${s.waybillNumber} ატვირთულია. მარშრუტი: ${route.start} → ${route.end}.${truck ? ` მანქანა: ${truck.plateNumber}.` : ''}${start}`
  const failed = (msg: string) => patch(id, (x) => ({ sms: { ...x.sms, status: 'failed', error: msg, at: nowIso(), to: driver.phone, text } }), { level: 'error', message: msg })

  // A send interrupted by a restart: if smsoffice.ge knows the message, it went out. Don't send it twice.
  if (s.sms.status === 'running' && s.sms.reference && s.sms.destination && s.sms.to === driver.phone) {
    const known = await smsDelivery(s.sms.destination, s.sms.reference, id).catch(() => null)
    if (known && known !== 'Unknown') {
      patch(id, (x) => ({ sms: { ...x.sms, status: 'ok', error: undefined, at: nowIso(), delivery: known, deliveryCheckedAt: nowIso() } }), {
        level: 'success',
        message: `მძღოლს გაეგზავნა SMS (${driver.phone})`,
      })
      return
    }
  }

  const c = smsCreds()
  const destination = toDestination(driver.phone)
  if (!c) return failed('SMS-ის პარამეტრები არ არის შევსებული — მიმართე ადმინისტრატორს')
  if (!destination) return failed(`მძღოლის ნომერი (${driver.phone}) არ არის ქართული მობილურის ნომერი`)
  const reference = newReference()
  // Recorded before the call, so a restart in between can ask smsoffice.ge instead of sending again.
  patch(id, () => ({ sms: { status: 'running', to: driver.phone, text, destination, reference } }))
  try {
    await smsoffice.send(c, destination, text, reference, id)
    patch(id, (x) => ({ sms: { ...x.sms, status: 'ok', error: undefined, at: nowIso(), delivery: 'Pending' } }), {
      level: 'success',
      message: `მძღოლს გაეგზავნა SMS (${driver.phone})`,
    })
    // The phone usually confirms within a minute: look once by then, so lists show it without opening the shipment.
    setTimeout(() => void checkDelivery(id).catch(() => {}), DELIVERY_FIRST_CHECK_MS).unref()
  } catch (e) {
    failed((e as Error).message)
  }
}

/** First delivery check after sending; later ones happen when the shipment is opened. */
const DELIVERY_FIRST_CHECK_MS = 60_000
/** Delivery is not asked again within this long. */
const DELIVERY_FRESH_MS = 15_000
/** After this long a still-pending SMS is left as it is (smsoffice.ge stops tracking it). */
const DELIVERY_MAX_AGE_MS = 7 * 86400_000
const checkingSms = new Map<string, Promise<void>>()

const DELIVERY_EVENT: Partial<Record<SmsDelivery, Omit<ShipmentEvent, 'at'>>> = {
  Delivered: { level: 'success', message: 'SMS მძღოლს მიუვიდა' },
  Undelivered: { level: 'error', message: 'SMS მძღოლს ვერ მიუვიდა — შეამოწმე ნომერი და გაგზავნე ხელახლა' },
  Expired: { level: 'error', message: 'SMS-ის მიწოდების ვადა გავიდა (ტელეფონი გამორთული იყო?) — გაგზავნე ხელახლა' },
}

/** Delivery of one message, or null when smsoffice.ge doesn't know it. */
async function smsDelivery(destination: string, reference: string, shipmentId: string): Promise<SmsDelivery | null> {
  const c = smsCreds()
  if (!c) return null
  try {
    return await smsoffice.status(c, destination, reference, shipmentId)
  } catch (e) {
    if (e instanceof IntegrationError && e.rejected) return null
    throw e
  }
}

/** Reads the SMS's delivery status from smsoffice.ge, unless it is final, fresh or too old to ask. */
function checkDelivery(id: string): Promise<void> {
  const s = get(id)
  const { status, reference, destination, delivery, deliveryCheckedAt, at } = s.sms
  if (status !== 'ok' || !reference || !destination || (delivery && SMS_FINAL.includes(delivery))) return Promise.resolve()
  if (deliveryCheckedAt && Date.now() - Date.parse(deliveryCheckedAt) < DELIVERY_FRESH_MS) return Promise.resolve()
  if (at && Date.now() - Date.parse(at) > DELIVERY_MAX_AGE_MS) return Promise.resolve()
  let p = checkingSms.get(id)
  if (!p) {
    p = smsDelivery(destination, reference, id).then((now) => {
      // Only if this is still the same message (not re-sent meanwhile).
      if (!now || get(id).sms.reference !== reference) return
      patch(id, (x) => ({ sms: { ...x.sms, delivery: now, deliveryCheckedAt: nowIso() } }), now !== delivery ? DELIVERY_EVENT[now] : undefined)
    })
    checkingSms.set(id, p)
    void p.catch(() => {}).finally(() => checkingSms.delete(id))
  }
  return p
}

/* ------------------------------ Logs ------------------------------ */

export const logs = {
  clear(user: User) {
    requireAdmin(user)
    db.clearLogs()
  },
}
