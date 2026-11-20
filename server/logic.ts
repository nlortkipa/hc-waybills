/**
 * Business rules. Every check that used to run in the browser runs here now, so a
 * client cannot skip it. Errors are thrown with the Georgian message shown to the user.
 */
import { canUseCarrier, resolveRoute, routeLive, routeText } from '../src/lib/route.ts'
import { akcizUnit, itemAmount, MAX_DEFER_MS, noTransport, plateKey, RS_TRANS_CAR, RS_UNIT_OTHER, RS_VAT_TYPES, rsMissing, rsUnits, shipmentWaybill, waybillDefaults } from '../src/lib/rs.ts'
import { active, nowIso, phoneKey, shipmentUses, tbilisiStamp, uid } from '../src/lib/util.ts'
import { SMS_FINAL } from '../src/lib/sms.ts'
import type {
  Carrier,
  CarrierRoute,
  Database,
  Driver,
  Product,
  RouteWaybill,
  RsListWaybill,
  RsRemoteWaybill,
  RsSettings,
  RsWaybillPayload,
  Shipment,
  ShipmentEvent,
  ShipmentItem,
  ShipmentWaybill,
  SmsDelivery,
  StoredDatabase,
  Truck,
  User,
  WaybillType,
} from '../src/types.ts'
import { createHash, randomInt } from 'node:crypto'
import { IntegrationError } from './integrations.ts'
import { rsCache } from './rscache.ts'
import { rsDate, rsge, storedCreds, type XmlGood } from './rsge.ts'
import { AUTO_CLOSE_MS, configProblems, SMS_API_KEY, SMS_SENDER, RS_SU } from './config.ts'
import { newReference, smsoffice, toDestination, type SmsCreds } from './smsoffice.ts'
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

/** Login codes sent by SMS, by phone key: only a hash is kept, and only in memory. */
const loginCodes = new Map<string, { hash: string; expires: number; tries: number; sentAt: number; sends: number[] }>()
const CODE_TTL_MS = 5 * 60_000
const CODE_RESEND_MS = 45_000
const CODE_MAX_TRIES = 5
const CODE_SENDS_PER_HOUR = 6
const hashCode = (key: string, code: string) => createHash('sha256').update(`${key}:${code}`).digest('hex')
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of loginCodes) if (v.expires < now && !v.sends.some((t) => now - t < 3600_000)) loginCodes.delete(k)
}, 10 * 60_000).unref()

/**
 * The SMS with the login code. Its last line (`@host #code`) lets Chrome on Android offer the code
 * on the login form (WebOTP); it is only added for the site's own https address.
 */
export function loginSmsText(code: string, origin?: string): string {
  let host = ''
  try {
    const u = new URL(origin ?? '')
    if (u.protocol === 'https:') host = u.host
  } catch {
    /* no origin */
  }
  return `HC Portal: შესვლის კოდი ${code}` + (host ? `\n\n@${host} #${code}` : '')
}

export const auth = {
  /** Texts a 6-digit login code to a known user's number. */
  async sendCode(phone: string, origin?: string): Promise<{ resendIn: number }> {
    const key = phoneKey(String(phone ?? ''))
    const user = active(db.get().users).find((u) => phoneKey(u.phone) === key)
    if (!key || !user) fail('ამ ნომრით მომხმარებელი ვერ მოიძებნა', 401)
    const destination = toDestination(user!.phone)
    if (!destination) fail('ეს ნომერი არ არის ქართული მობილურის ნომერი — მიმართე ადმინისტრატორს')
    const now = Date.now()
    const prev = loginCodes.get(key)
    const sends = (prev?.sends ?? []).filter((t) => now - t < 3600_000)
    if (prev && now - prev.sentAt < CODE_RESEND_MS) return { resendIn: Math.ceil((CODE_RESEND_MS - (now - prev.sentAt)) / 1000) }
    if (sends.length >= CODE_SENDS_PER_HOUR) fail('ძალიან ბევრი მცდელობა — სცადე ერთ საათში', 429)
    const c = smsCreds()
    if (!c) fail('SMS სერვისი არ არის დაკავშირებული', 503)
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    try {
      await smsoffice.send(c!, destination!, loginSmsText(code, origin), newReference(), undefined, loginSmsText('••••••', origin))
    } catch (e) {
      fail(`კოდი ვერ გაიგზავნა: ${(e as Error).message}`, 502)
    }
    loginCodes.set(key, { hash: hashCode(key, code), expires: now + CODE_TTL_MS, tries: 0, sentAt: now, sends: [...sends, now] })
    return { resendIn: Math.ceil(CODE_RESEND_MS / 1000) }
  },
  /** Checks the SMS code and starts a session. */
  login(phone: string, code: string): { token: string; user: User } {
    const key = phoneKey(String(phone ?? ''))
    const user = active(db.get().users).find((u) => phoneKey(u.phone) === key)
    if (!key || !user) fail('ამ ნომრით მომხმარებელი ვერ მოიძებნა', 401)
    const entry = loginCodes.get(key)
    const typed = String(code ?? '').replace(/\D/g, '')
    if (!entry || entry.expires < Date.now() || entry.tries >= CODE_MAX_TRIES) fail('კოდს ვადა გაუვიდა — მოითხოვე ახალი', 401)
    if (!typed || hashCode(key, typed) !== entry!.hash) {
      entry!.tries++
      fail(entry!.tries >= CODE_MAX_TRIES ? 'კოდი არასწორია — მოითხოვე ახალი' : 'კოდი არასწორია', 401)
    }
    loginCodes.set(key, { ...entry!, expires: 0, hash: '', sentAt: 0 })
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

/* ------------------------- RS.ge's data in views ------------------------- */

/** The RS.ge settings with what RS.ge says about the account (never stored) filled in. */
export function rsView(): RsSettings {
  const a = rsge.account()
  const products = rsCache.productsStatus()
  const plates = rsCache.platesStatus()
  const changes = rsCache.changesStatus()
  return {
    ...db.get().rs,
    sellerUnId: a?.unId ?? null,
    sellerUserId: a?.userId ?? null,
    sellerTin: a?.tin ?? '',
    sellerName: a?.name ?? '',
    checkedAt: a?.checkedAt,
    accountError: a ? undefined : rsge.accountError(),
    units: a?.units ?? [],
    akciz: a?.akciz ?? [],
    syncedTo: changes.to,
    syncError: changes.error,
    productsSyncedAt: products.at,
    productsSyncError: products.error,
    platesReadAt: plates.at,
    platesError: plates.error,
  }
}

/**
 * The trucks as the app shows them: every plate on RS.ge's car-number list, with the model and trailer
 * stored here for it (a plate with nothing stored gets the id `rs-<PLATE>`). Stored trucks whose plate
 * is gone from RS.ge are shown deleted, so history still names them. Before RS.ge's list has been read
 * (or without a connection) the stored trucks are shown as they are.
 */
export function trucksView(stored = db.get().trucks): Truck[] {
  const plates = rsCache.plates()
  if (!plates) return stored
  const onRs = new Set(plates.map(plateKey))
  const byKey = new Map(active(stored).map((t) => [plateKey(t.plateNumber), t]))
  const out: Truck[] = stored.map((t) => (t.deletedAt || onRs.has(plateKey(t.plateNumber)) ? t : { ...t, deletedAt: 'rs' }))
  for (const p of plates) if (!byKey.has(plateKey(p))) out.push({ id: `rs-${plateKey(p)}`, model: '', plateNumber: p, trailerNumber: '' })
  return out
}

/** waybillState for an RS.ge status: completed → closed, deleted or cancelled → cancelled. */
const stateOf = (status: number): Shipment['waybillState'] => (status === 2 ? 'closed' : status < 0 ? 'cancelled' : undefined)

/** What the operator typed into COMMENT: without the trailer added in front and the HC tag at the end. */
function typedComment(comment: string, shipmentId: string) {
  let c = comment
  const ref = refTag(shipmentId)
  if (c === ref) c = ''
  else if (c.endsWith(`; ${ref}`)) c = c.slice(0, -(ref.length + 2))
  if (c.startsWith('მისაბმელი: ')) {
    const k = c.indexOf('; ')
    c = k < 0 ? '' : c.slice(k + 2)
  }
  return c
}

/** RS.ge's goods rows as the shipment's goods lines. */
function itemsFrom(w: RsRemoteWaybill, akciz: RsSettings['akciz']): ShipmentItem[] {
  return w.goods.map((g) => {
    const a = g.aId ? akciz?.find((x) => x.id === g.aId) : undefined
    return {
      name: g.name,
      barCode: g.barCode,
      unitId: g.unitId ?? RS_UNIT_OTHER,
      unitTxt: g.unitTxt,
      price: g.price,
      // A total RS.ge has that isn't quantity × price was typed in there: keep it.
      ...(g.amount !== itemAmount({ quantity: g.quantity, price: g.price }) && { amount: g.amount }),
      vatType: ([0, 1, 2] as const).find((v) => v === g.vatType) ?? 0,
      ...(g.aId ? { aId: g.aId, aTitle: a ? `${a.code} · ${a.title}` : String(g.aId) } : {}),
      quantity: g.quantity,
      ...(g.quantityExt ? { quantityExt: g.quantityExt } : {}),
    }
  })
}

/** RS.ge's waybill as the shipment's waybill options. */
function waybillFrom(w: RsRemoteWaybill, shipmentId: string): ShipmentWaybill {
  const type = ((w.type ?? 1) as WaybillType) || 1
  const buyer = type === 1 ? { buyerTin: '', buyerName: '', buyerForeign: false } : { buyerTin: w.buyerTin, buyerName: w.buyerName, buyerForeign: !!w.buyerForeign }
  return {
    type,
    ...buyer,
    ...(w.beginAt && Date.parse(w.beginAt) > Date.now() && { beginAt: w.beginAt }),
    transportCost: w.transportCost,
    receptionInfo: w.receptionInfo ?? '',
    receiverInfo: w.receiverInfo ?? '',
    comment: typedComment(w.comment, shipmentId),
  }
}

/**
 * The shipment with what RS.ge has filled in: its waybill as RS.ge has it now (rsRemote), its state and
 * invoice and, once only RS.ge has them, its goods, quantity and waybill options. Without RS.ge's copy
 * (not read yet, or RS.ge unreachable) those stay empty.
 */
export function withRs(s: Shipment, akciz = rsge.account()?.akciz): Shipment {
  const w = s.rsWaybillId ? rsCache.waybill(s.rsWaybillId) : undefined
  // State and invoice count once the pipeline is done with RS.ge (a retry in progress records its own).
  const settled = s.status === 'uploaded' || s.status === 'saved'
  const out: Shipment = w
    ? { ...s, rsRemote: w, ...(settled && { waybillState: stateOf(w.status), invoiceId: w.invoiceId }), waybillNumber: s.waybillNumber || (w.status > 0 && w.number) || undefined }
    : { ...s }
  if (!s.items) {
    out.items = w ? itemsFrom(w, akciz) : []
    out.quantity = w?.quantity ?? 0
    if (w) out.waybill = { ...waybillFrom(w, s.id), ...(s.waybill?.beginAt && { beginAt: s.waybill.beginAt }) }
  }
  return out
}

/**
 * What a user is allowed to see: operators only get their own carriers' shipments. The RS.ge password
 * and SMS key never leave the server. RS.ge's data (products, plates, waybills, the seller) is added here.
 */
export function viewFor(user: User): Database {
  const raw = db.get()
  const rs = rsView()
  const d: Database = {
    ...raw,
    rs: { ...rs, su: user.role === 'admin' ? RS_SU : '' },
    sms: { ...raw.sms, sender: SMS_SENDER },
    products: rsCache.products(),
    trucks: trucksView(raw.trucks),
    shipments: raw.shipments.filter((s) => canUseCarrier(user, s.carrierId)).map((s) => withRs(s, rs.akciz)),
  }
  if (user.role !== 'operator') return d
  const mine = new Set(d.shipments.map((s) => s.id))
  return { ...d, logs: d.logs.filter((l) => l.shipmentId && mine.has(l.shipmentId)) }
}

/* ------------------------- Reference data ------------------------- */

export const REF_COLLECTIONS = ['carriers', 'routes', 'drivers', 'trucks', 'products', 'users'] as const
export type RefCollection = (typeof REF_COLLECTIONS)[number]
type RefRecord = Database[RefCollection][number]

const requireAdmin = (u: User) => u.role === 'admin' || fail('მოქმედება ხელმისაწვდომია მხოლოდ ადმინისტრატორისთვის', 403)

/** Active admins other than `id`. The last admin can't be deleted or demoted, so the system always has one. */
const otherAdmins = (id: string) => active(db.get().users).filter((u) => u.role === 'admin' && u.id !== id).length
const LAST_ADMIN = 'ეს ერთადერთი ადმინისტრატორია — ჯერ დანიშნე სხვა ადმინისტრატორი.'

function shipmentCount(col: Exclude<RefCollection, 'products'>, id: string): number {
  return db.get().shipments.filter((s) => shipmentUses(s, col, id)).length
}

/** Removes a record, or soft-deletes it when shipments reference it so they keep showing it. */
function removeOrRetire(col: Exclude<RefCollection, 'products'>, rec: RefRecord) {
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
 * The goods lines of a route, checked. Each is sent as written (filled from the product list or
 * typed in): RS.ge requires a name, bar code and unit on every line. Price ≥ 0, VAT 0/1/2, quantity > 0.
 * A unit or excise code RS.ge no longer lists is accepted only on a line the route already had.
 */
function parseItems(raw: unknown, prev: ShipmentItem[] = []): ShipmentItem[] {
  const rs = rsView()
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  if (!list.length) fail('დაამატე მინიმუმ ერთი პროდუქტი')
  if (list.length > MAX_GOODS) fail(`ერთ ზედნადებზე მაქსიმუმ ${MAX_GOODS} პროდუქტია`)
  const units = rsUnits(rs)
  const codes = new Set<string>()
  return list.map((x) => {
    const name = str(x?.name)
    const barCode = str(x?.barCode)
    const unitId = num(x?.unitId, RS_UNIT_OTHER)
    const unitTxt = unitId === RS_UNIT_OTHER ? str(x?.unitTxt) : (units.find((u) => u.id === unitId)?.name ?? str(x?.unitTxt))
    const label = name || barCode || 'პროდუქტი'
    if (!barCode) fail(`„${label}“: ჩაწერე შტრიხკოდი — RS.ge მას ყველა პროდუქტზე ითხოვს`)
    if (!name) fail(`„${label}“: ჩაწერე დასახელება`)
    if (name.length > 250 || barCode.length > 50) fail(`„${label}“: დასახელება ან შტრიხკოდი ძალიან გრძელია`)
    const was = prev.find((y) => y.barCode.toLowerCase() === barCode.toLowerCase())
    if (!units.some((u) => u.id === unitId) && was?.unitId !== unitId) fail(`„${label}“: აირჩიე საზომი ერთეული`)
    if (!unitTxt) fail(`„${label}“: ჩაწერე ერთეულის დასახელება`)
    if (codes.has(barCode.toLowerCase())) fail(`„${label}“: ეს შტრიხკოდი ზედნადებზე ორჯერ არის`)
    codes.add(barCode.toLowerCase())
    const price = x?.price === '' || x?.price == null ? NaN : Number(x.price)
    if (!(price >= 0)) fail(`„${label}“: შეიყვანე ფასი (0 ან მეტი)`)
    const vatType = ([0, 1, 2] as const).find((v) => v === Number(x?.vatType))
    if (vatType == null) fail(`„${label}“: აირჩიე დაბეგვრის ტიპი`)
    const quantity = Math.round(num(x?.quantity) * 1000) / 1000
    if (!(quantity > 0)) fail(`„${label}“: რაოდენობა უნდა იყოს 0-ზე მეტი`)
    const quantityExt = Math.round(num(x?.quantityExt) * 1000) / 1000
    if (quantityExt < 0) fail(`„${label}“: დამატებითი რაოდენობა არ შეიძლება იყოს უარყოფითი`)
    // საქონლის ფასი: missing = quantity × price; one typed in is kept (as RS.ge's form allows).
    const amount = x?.amount === '' || x?.amount == null ? undefined : Math.round(Number(x.amount) * 100) / 100
    if (amount != null && !(amount >= 0)) fail(`„${label}“: საქონლის ფასი უნდა იყოს 0 ან მეტი`)
    // Excise goods: a code RS.ge lists (or the one the line already had, if RS.ge's list isn't loaded).
    const aId = Math.max(0, Math.trunc(num(x?.aId)))
    const akciz = aId ? rs.akciz?.find((a) => a.id === aId) : undefined
    const kept = aId && was?.aId === aId ? was : undefined
    if (aId && !akciz && !kept) fail(`„${label}“: აქციზის კოდი ვერ მოიძებნა — აირჩიე სიიდან`)
    // As on RS.ge's form, excise goods go under their excise goods code.
    if (akciz && akciz.code.toLowerCase() !== barCode.toLowerCase()) fail(`„${label}“: აქციზური საქონლის შტრიხკოდი მისი აქციზის კოდია (${akciz.code})`)
    const fixed = akciz && akcizUnit(rs, akciz)
    if (fixed && (fixed.unitId !== unitId || (unitId === RS_UNIT_OTHER && fixed.unitTxt !== unitTxt))) fail(`„${label}“: აქციზური საქონლის ერთეული მისი აქციზის ერთეულია (${fixed.unitTxt})`)
    const excise = aId ? { aId, aTitle: akciz ? `${akciz.code} · ${akciz.title}` : (kept!.aTitle ?? String(aId)) } : {}
    return { name, barCode, unitId, unitTxt, price: Math.round(price * 10000) / 10000, ...(amount != null && { amount }), vatType: vatType!, ...excise, quantity, ...(quantityExt > 0 && { quantityExt }) }
  })
}

export const refs = {
  /** `token` is the caller's session: kept when admins change their own phone or role. */
  async save(col: RefCollection, record: RefRecord & { id?: string }, by: User, token?: string) {
    requireAdmin(by)
    // Products are RS.ge's: one is known by its bar code, which is its id.
    if (col === 'products') {
      const prev = record.id ? rsCache.products().find((p) => p.id === record.id) : undefined
      if (record.id && !prev) fail('პროდუქტი RS.ge-ს სიაში ვეღარ მოიძებნა — განაახლე გვერდი', 404)
      return productLock(() => saveProduct(record as Product, prev))
    }
    // A truck known only from RS.ge's car numbers (rs-…) gets its record here now.
    if (col === 'trucks' && record.id?.startsWith('rs-')) record = { ...record, id: '' }
    const rec = { ...record, id: record.id || uid(col[0]) } as RefRecord
    const prev = (db.get()[col] as RefRecord[]).find((r) => r.id === rec.id)
    if (prev?.deletedAt) fail('ჩანაწერი წაშლილია')
    if (col === 'trucks') return productLock(() => saveTruck(rec as Truck, prev as Truck | undefined))
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
      // not at the first upload. A Georgian number can't be saved unchecked, so it needs RS.ge
      // connected; a foreign one is checked only while it is.
      const changed = !was || was.personalId.trim() !== x.personalId || (was.citizenship ?? 'GE') !== x.citizenship
      if (changed && x.citizenship === 'GE') {
        if (!storedCreds()) fail('ქართველი მძღოლის პირადი ნომერი RS.ge-ზე მოწმდება — ჯერ დაუკავშირდი RS.ge-ს')
        if (!(await rsName(x.personalId))) fail('ეს პირადი ნომერი RS.ge-ს რეესტრში ვერ მოიძებნა')
      }
      if (changed && x.citizenship === 'foreign' && storedCreds() && (await rsName(x.personalId))) fail('ეს პირადი ნომერი საქართველოს რეესტრშია — აირჩიე „საქართველოს მოქალაქე“')
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
      const raw = r as unknown as Record<string, unknown>
      const carrierId = str(r.carrierId)
      const carrier = d.carriers.find((c) => c.id === carrierId)
      if (!carrier || carrier.deletedAt) fail('აირჩიე კარიერი')
      const endAddress = str(r.endAddress).trim()
      if (!endAddress) fail('შეიყვანე დასრულების მისამართი')
      const scaleId = str(r.scaleId).trim()
      if (!scaleId) fail('შეიყვანე სასწორის ID')
      const goods = parseItems(raw.goods, was?.goods)
      const extras = parseRouteWaybill(raw)
      // Only these fields are kept.
      for (const k of Object.keys(raw)) if (k !== 'id') delete raw[k]
      Object.assign(r, { carrierId, endAddress, scaleId, goods, ...extras })
      // One route per address. Checked only when it changes: routes that differed by the buyer before v28 can still be edited.
      const key = (x: CarrierRoute) => [x.carrierId, x.endAddress.trim().toLowerCase()].join('|')
      if ((!was || key(was) !== key(r)) && active(d.routes).some((x) => x.id !== r.id && key(x) === key(r))) fail('ეს მარშრუტი უკვე არსებობს')
    }
    db.put(col, rec as never)
    if (revokeSessions) db.sessions.deleteForUser(rec.id, rec.id === by.id ? token : undefined)
    return rec
  },

  /** Deletes a record. If shipments reference it, it is soft-deleted so reports keep showing it. */
  async remove(col: RefCollection, id: string, by: User) {
    requireAdmin(by)
    if (col === 'products') return productLock(() => removeProduct(id))
    if (col === 'trucks') return productLock(() => removeTruck(id))
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

const MAX_INFO = 250

/**
 * A route's transport details, checked: the transport type is always საავტომობილო, so only a cost ≥ 0
 * and the comment. Only what differs from the default is kept.
 */
function parseRouteWaybill(x: Record<string, unknown>): RouteWaybill {
  const text = (v: unknown, label: string) => {
    const t = str(v).trim()
    if (t.length > MAX_INFO) fail(`${label}: მაქსიმუმ ${MAX_INFO} სიმბოლო`)
    return t
  }
  const transportCost = str(x.transportCost) ? num(String(x.transportCost).replace(',', '.'), NaN) : 0
  if (!(transportCost >= 0)) fail('ტრანსპორტირების ხარჯი უნდა იყოს 0 ან მეტი')
  const out: RouteWaybill = {
    transportCost: Math.round(transportCost * 100) / 100,
    comment: text(x.comment, 'კომენტარი'),
  }
  const base = waybillDefaults()
  for (const k of Object.keys(out) as (keyof RouteWaybill)[]) if (out[k] === base[k]) delete out[k]
  return out
}

/* ------------------------------ Products ------------------------------ */

/*
 * Products are the connected taxpayer's product list on RS.ge, and nothing is stored here: the list is
 * read from RS.ge (server/rscache.ts); adding, editing and deleting go to RS.ge, and the list is read
 * again right after. A product's id is its bar code.
 */

/** Product and truck changes run one at a time, so two changes never race on RS.ge's lists. */
let productChain: Promise<unknown> = Promise.resolve()
function productLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = productChain.then(fn, fn)
  productChain = run.catch(() => {})
  return run
}

const productCreds = () => storedCreds() ?? fail('ჯერ დაუკავშირდი RS.ge-ს — პროდუქტები RS.ge-ზე ინახება')

async function saveProduct(input: Product, prev: Product | undefined): Promise<Product> {
  productCreds()
  const rs = rsView()
  const unitId = Number(input.unitId)
  const barCode = str(input.barCode)
  const price = str(input.price) === '' ? NaN : Number(input.price)
  const vatType = ([0, 1, 2] as const).find((v) => v === Number(input.vatType))
  const p: Product = {
    id: barCode,
    name: str(input.name),
    barCode,
    unitId,
    unitTxt: unitId === RS_UNIT_OTHER ? str(input.unitTxt) : (rsUnits(rs).find((u) => u.id === unitId)?.name ?? ''),
    // The excise code isn't edited here: a product keeps the one RS.ge has.
    aId: prev?.aId ?? 0,
    price: Math.round(price * 10000) / 10000,
    vatType: vatType!,
  }
  if (!p.barCode) fail('შეიყვანე საქონლის კოდი')
  if (!p.name) fail('შეიყვანე საქონლის დასახელება')
  // RS.ge knows a product only by its bar code: a new code is added there and the old one deleted.
  const renamed = !!prev && prev.barCode !== p.barCode
  if (renamed && prev!.barCode.toLowerCase() === p.barCode.toLowerCase()) fail('კოდში მხოლოდ ასოების ზომის შეცვლა შეუძლებელია')
  if (!(unitId > 0) || !p.unitTxt) fail(unitId === RS_UNIT_OTHER ? '„სხვა“ ერთეულისთვის შეიყვანე ერთეულის დასახელება' : 'აირჩიე ზომის ერთეული')
  if (!(price >= 0)) fail('შეიყვანე ერთეულის თანხა (0 ან მეტი)')
  if (vatType == null) fail('აირჩიე დაბეგვრა')
  const key = p.barCode.toLowerCase()
  if ((!prev || renamed) && rsCache.products().some((x) => x !== prev && x.barCode.toLowerCase() === key)) fail('ამ კოდით პროდუქტი უკვე არსებობს')
  // Price and VAT type are stored here only: RS.ge is written to when what it keeps changed.
  if (!prev || renamed || prev.name !== p.name || prev.unitId !== p.unitId || prev.unitTxt !== p.unitTxt) {
    // A code already on RS.ge (added on the portal since the list was read) is overwritten there, as on the portal.
    await rsge.saveBarCode({ ...p, aId: p.aId ?? 0 }).catch((e: Error) => fail(e.message, 502))
    // RS.ge answers "saved" even when it drops the code, so only what it reads back counts.
    const got = await rsge.barCode(p.barCode).catch((e: Error) => fail(`RS.ge-მ შენახვა დაადასტურა, მაგრამ შემოწმება ვერ მოხერხდა: ${e.message}`, 502))
    await rsCache.loadProducts().catch(() => {})
    if (!got) fail(`RS.ge-მ კოდი „${p.barCode}“ არ შეინახა — სავარაუდოდ ის უკვე სხვა გადამხდელს აქვს რეგისტრირებული. გამოიყენე სხვა, უნიკალური კოდი.`, 502)
    if (got!.name !== p.name || got!.unitId !== p.unitId) fail('RS.ge-მ ცვლილება არ შეინახა — სცადე თავიდან ან შეცვალე RS.ge-ს პორტალზე.', 502)
  }
  db.productPrices.set(p.barCode, p.price!, p.vatType!)
  if (renamed) {
    // Waybills and routes keep their own copy of the goods, so the old code can go.
    db.productPrices.remove([prev!.barCode])
    const dropped = await rsge.deleteBarCode(prev!.barCode).then(
      () => true,
      () => false,
    )
    await rsCache.loadProducts().catch(() => {})
    if (!dropped) fail(`ახალი კოდი „${p.barCode}“ RS.ge-ზე დაემატა, მაგრამ ძველი „${prev!.barCode}“ ვერ წაიშალა — წაშალე ის სიიდან.`, 502)
  }
  return p
}

async function removeProduct(id: string) {
  productCreds()
  const p = rsCache.products().find((x) => x.id === id) ?? fail('ჩანაწერი ვერ მოიძებნა', 404)
  await rsge.deleteBarCode(p.barCode).catch((e: Error) => fail(e.message, 502))
  db.productPrices.remove([p.barCode])
  await rsCache.loadProducts().catch(() => {})
}

/**
 * Deletes every product, here and on RS.ge (RS.ge has no "delete all": each code is deleted on its
 * own). The list is read from RS.ge first, so codes added on the portal go too. Codes RS.ge still
 * lists afterwards are counted as not deleted.
 */
export function clearProducts(user: User) {
  requireAdmin(user)
  return productLock(async () => {
    productCreds()
    const list = await rsCache.loadProducts().catch((e: Error) => fail(`RS.ge-დან პროდუქტების სია ვერ წაიკითხა: ${e.message}`, 502))
    for (const p of list) await rsge.deleteBarCode(p.barCode).catch(() => {})
    const left = await rsCache.loadProducts().catch((e: Error) => fail(`წაშლის შემდეგ RS.ge-დან სია ვერ წაიკითხა: ${e.message}`, 502))
    const kept = new Set(left.map((p) => p.barCode.toLowerCase()))
    const gone = list.filter((p) => !kept.has(p.barCode.toLowerCase()))
    db.productPrices.remove(gone.map((p) => p.barCode))
    return { deleted: gone.length, failed: left.length }
  })
}

/** The product list is read again on page open only when the last read is older than this. */
const PRODUCTS_FRESH_MS = 30_000

/**
 * Reads RS.ge's product list (or car-number list) now. Asked by the products and trucks tabs and the
 * new-shipment page when they open (only if the last read is older than PRODUCTS_FRESH_MS), and by
 * the admin's "refresh" button (`force`, which reports a failure).
 */
export async function readRsList(what: 'products' | 'plates', body: { force?: boolean } | undefined, user: User) {
  const force = !!body?.force
  if (force) requireAdmin(user)
  if (!storedCreds()) return force ? fail('ჯერ დაუკავშირდი RS.ge-ს') : undefined
  const status = what === 'products' ? rsCache.productsStatus() : rsCache.platesStatus()
  if (!force && !status.error && status.at && Date.now() - Date.parse(status.at) < PRODUCTS_FRESH_MS) return
  const load = what === 'products' ? rsCache.loadProducts() : rsCache.loadPlates()
  await load.catch((e: Error) => force && fail(e.message, 502))
}

/* ------------------------------ Trucks ------------------------------ */

const truckCreds = () => storedCreds() ?? fail('ჯერ დაუკავშირდი RS.ge-ს — მანქანების ნომრები RS.ge-ზე ინახება')

/** RS.ge's car numbers, read now. */
const readPlates = () => rsCache.loadPlates().catch((e: Error) => fail(`RS.ge-დან მანქანების სია ვერ წაიკითხა: ${e.message}`, 502))

/** Whether another stored truck (not `exceptId`) still has this plate. */
const plateUsed = (key: string, exceptId: string) => active(db.get().trucks).some((x) => x.id !== exceptId && plateKey(x.plateNumber) === key)

/**
 * Saves a truck: its plate goes onto RS.ge's car-number list (checked by reading it back), the model and
 * trailer are stored here. A changed plate leaves RS.ge's list unless another truck still has it.
 */
async function saveTruck(input: Truck, prev: Truck | undefined): Promise<Truck> {
  truckCreds()
  const t: Truck = { id: input.id, model: str(input.model), plateNumber: str(input.plateNumber), trailerNumber: str(input.trailerNumber) }
  const key = plateKey(t.plateNumber)
  if (!key) fail('შეიყვანე სახელმწიფო ნომერი')
  if (plateUsed(key, t.id)) fail('ამ ნომრით მანქანა უკვე არსებობს')
  if (!(await readPlates()).some((p) => plateKey(p) === key)) {
    await rsge.saveCarNumber(key).catch((e: Error) => fail(e.message, 502))
    if (!(await readPlates()).some((p) => plateKey(p) === key)) fail(`RS.ge-მ ნომერი „${key}“ არ შეინახა — სცადე თავიდან ან დაამატე RS.ge-ს პორტალზე.`, 502)
  }
  const old = prev && plateKey(prev.plateNumber)
  if (old && old !== key && !plateUsed(old, t.id)) {
    await rsge.deleteCarNumber(old).catch((e: Error) => fail(`ახალი ნომერი შეინახა, მაგრამ ძველი (${old}) RS.ge-ს სიიდან ვერ წაიშალა: ${e.message}`, 502))
    await rsCache.loadPlates().catch(() => {})
  }
  db.put('trucks', t)
  return t
}

/** Deletes a truck: its plate leaves RS.ge's car-number list (unless another truck has it), its record goes or is retired. */
async function removeTruck(id: string) {
  truckCreds()
  const t = trucksView().find((x) => x.id === id) ?? fail('ჩანაწერი ვერ მოიძებნა', 404)
  const key = plateKey(t.plateNumber)
  if (!plateUsed(key, id) && (await readPlates()).some((p) => plateKey(p) === key)) {
    await rsge.deleteCarNumber(key).catch((e: Error) => fail(e.message, 502))
    await rsCache.loadPlates().catch(() => {})
  }
  const rec = db.get().trucks.find((x) => x.id === id)
  if (rec) removeOrRetire('trucks', rec)
}

/**
 * Deletes every truck: every plate on RS.ge's car-number list is deleted there (one by one), and the
 * stored trucks go (or are retired when shipments use them). Stored trucks whose plate RS.ge still
 * lists afterwards stay, and those plates are counted as not deleted.
 */
export function clearTrucks(user: User) {
  requireAdmin(user)
  truckCreds()
  return productLock(async () => {
    const list = await readPlates()
    for (const p of list) await rsge.deleteCarNumber(plateKey(p)).catch(() => {})
    const left = new Set((await readPlates()).map(plateKey))
    const stored = active(db.get().trucks)
    for (const t of stored) if (!left.has(plateKey(t.plateNumber))) removeOrRetire('trucks', t)
    const gone = new Set([...list.map(plateKey), ...stored.map((t) => plateKey(t.plateNumber))].filter((k) => k && !left.has(k)))
    return { deleted: gone.size, failed: left.size }
  })
}

/**
 * Puts the plates of stored trucks that RS.ge's car-number list doesn't have (trucks added before
 * plates lived on RS.ge, or plates deleted on the portal) onto it, so they can be picked again.
 * Asked for by the admin: a plate deleted on the portal is not put back on its own.
 */
export async function pushPlates(user: User) {
  requireAdmin(user)
  truckCreds()
  return productLock(async () => {
    const onRs = new Set((await readPlates()).map(plateKey))
    const missing = [...new Set(active(db.get().trucks).map((t) => plateKey(t.plateNumber)))].filter((k) => k && !onRs.has(k))
    const failed: string[] = []
    for (const key of missing) await rsge.saveCarNumber(key).catch(() => failed.push(key))
    const after = new Set((await readPlates()).map(plateKey))
    const notSaved = missing.filter((k) => !after.has(k))
    if (notSaved.length) fail(`RS.ge-მ ეს ნომრები არ შეინახა: ${notSaved.join(', ')}`, 502)
    return { added: missing.length }
  })
}

/** The stored truck for a picked one: a plate known only from RS.ge (`rs-…`) gets its record now. */
function truckRecord(id: string): string {
  if (!id.startsWith('rs-')) return id
  const key = id.slice(3)
  const have = active(db.get().trucks).find((t) => plateKey(t.plateNumber) === key)
  if (have) return have.id
  const plate = rsCache.plates()?.find((p) => plateKey(p) === key) ?? key
  const t: Truck = { id: uid('t'), model: '', plateNumber: plate, trailerNumber: '' }
  db.put('trucks', t)
  return t.id
}

/* ------------------------------ RS.ge ------------------------------ */

const num = (v: unknown, fallback = 0) => (v === '' || v == null || !Number.isFinite(Number(v)) ? fallback : Number(v))

/** Name RS.ge has for the number, '' when it doesn't know it. Needs the stored service user. */
async function rsName(tin: string) {
  const c = storedCreds() ?? fail('ჯერ დაუკავშირდი RS.ge-ს')
  return rsge.nameFromTin(c, tin).catch((e: Error) => fail(e.message, 502))
}

/** Name RS.ge's register has for a personal number or tax code ('' when none), for filling in forms. */
export async function rsTinName(tin: string, user: User) {
  requireAdmin(user)
  if (!/^\d{9}$|^\d{11}$/.test(tin)) fail('ნომერი უნდა იყოს 9 ან 11 ციფრი')
  return { tin, name: (await rsName(tin)).trim() }
}

/* ------------------------------ SMS ------------------------------ */

/** The smsoffice.ge account from .env. */
const smsCreds = (): SmsCreds | null => (SMS_API_KEY && SMS_SENDER ? { apiKey: SMS_API_KEY, sender: SMS_SENDER } : null)

/* ------------------------------ Startup ------------------------------ */

/**
 * Checks the accounts in .env before the server starts: both must be set, RS.ge must accept the service
 * user (the seller is read and kept) and smsoffice.ge the API key (the balance is kept). Resolves with
 * what went wrong, one line each; empty = both work.
 */
export async function checkServices(): Promise<string[]> {
  const problems = configProblems()
  if (problems.length) return problems
  const [rs, sms] = await Promise.allSettled([rsge.loadAccount(storedCreds()!), smsoffice.balance({ apiKey: SMS_API_KEY })])
  const why = (label: string, e: unknown) => ((e as Error).message.startsWith(label) ? (e as Error).message : `${label}: ${(e as Error).message}`)
  const out: string[] = []
  if (rs.status === 'rejected') out.push(why('RS.ge', rs.reason))
  if (sms.status === 'rejected') out.push(why('SMS', sms.reason))
  if (out.length) return out
  const balance = (sms as PromiseFulfilledResult<number>).value
  db.set('sms', { ...db.get().sms, balance, checkedAt: nowIso() })
  db.dropStoredAccounts()
  const a = (rs as PromiseFulfilledResult<Awaited<ReturnType<typeof rsge.loadAccount>>>).value
  console.log(`[rs.ge] connected: ${a.name} (${a.tin})`)
  console.log(`[sms] connected: sender ${SMS_SENDER}, ${balance} messages left`)
  void rsCache.loadProducts().catch(() => {})
  void rsCache.loadPlates().catch(() => {})
  return []
}

/**
 * Tag written into every waybill's COMMENT. If save_waybill's answer is lost, the next attempt
 * finds the waybill by this tag on RS.ge instead of creating a second one.
 */
const refTag = (shipmentId: string) => `HC:${shipmentId}`

type WaybillSource = Pick<Shipment, 'id' | 'routeId' | 'driverId' | 'truckId' | 'items' | 'waybill'>

/**
 * Builds the waybill for a shipment from its waybill options (type, transport details) and goods lines,
 * both taken from the route, and the chosen route, driver and truck.
 */
function buildWaybill(d: StoredDatabase, s: WaybillSource): RsWaybillPayload {
  const rs = rsView()
  const route = resolveRoute(d, s.routeId)
  const w = shipmentWaybill(s, route.route)
  const driver = d.drivers.find((x) => x.id === s.driverId)
  const truck = d.trucks.find((x) => x.id === s.truckId)
  const moving = !noTransport(w.type)
  const goods = s.items.map((g) => ({
    name: g.name,
    barCode: g.barCode,
    unitId: g.unitId,
    unitTxt: g.unitTxt,
    quantity: g.quantity,
    price: g.price,
    amount: itemAmount(g),
    vatType: g.vatType,
    aId: g.aId ?? 0,
    ...(g.quantityExt && { quantityExt: g.quantityExt }),
  }))
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
    // Always საავტომობილო, the seller paying the transport cost.
    transId: RS_TRANS_CAR,
    transTxt: '',
    tranCostPayer: 2,
    transportCost: moving ? w.transportCost : 0,
    transporterTin: '',
    receptionInfo: w.receptionInfo,
    receiverInfo: w.receiverInfo,
    // RS.ge has no trailer field, so the trailer goes into the comment.
    comment: [moving && truck?.trailerNumber && `მისაბმელი: ${truck.trailerNumber}`, w.comment, refTag(s.id)].filter(Boolean).join('; '),
    goods,
  }
}

/** Why a waybill can't be sent now, or null. Reads the seller from RS.ge when it isn't known since the server started. */
async function rsNotReady(): Promise<string | null> {
  if (storedCreds() && !rsge.account()) {
    const error = await rsge.loadAccount().then(
      () => null,
      (e: Error) => e.message,
    )
    if (error) return error
  }
  const missing = rsMissing(rsView(), { hasCreds: !!storedCreds() })
  return missing.length ? `RS.ge პარამეტრები არ არის შევსებული (${missing.join(', ')}) — მიმართე ადმინისტრატორს` : null
}

/* ---------------------------- Shipments ---------------------------- */

function patch(id: string, fn: (s: Shipment) => Partial<Shipment>, event?: Omit<ShipmentEvent, 'at'>) {
  db.updateShipment(id, (s) => ({ ...s, ...fn(s), events: event ? [...s.events, { at: nowIso(), ...event }] : s.events }))
}

/** The stored shipment. */
function stored(id: string, user?: User) {
  const s = db.get().shipments.find((x) => x.id === id)
  if (!s || (user && !canUseCarrier(user, s.carrierId))) return fail('რეისი ვერ მოიძებნა', 404)
  return s
}

/** The shipment with RS.ge's copy of its waybill filled in (as last read; see `current`). */
const get = (id: string, user?: User) => withRs(stored(id, user))

/**
 * The shipment with RS.ge's copy of its waybill, read now when none is held (after a restart, say).
 * Changing a waybill needs to know how it stands on RS.ge.
 */
async function current(id: string, user?: User) {
  const s = stored(id, user)
  if (s.rsWaybillId && !rsCache.waybill(s.rsWaybillId) && storedCreds()) await rsCache.read(s.rsWaybillId, id, 'page').catch(() => {})
  return get(id, user)
}

const noReport = (user: User) => user.role === 'report' && fail('რეპორტ მომხმარებელს არ შეუძლია ამ მოქმედების შესრულება', 403)

const running = new Set<string>()

/** What an operator picks for a shipment: everything else comes from the route. */
export interface NewShipmentInput {
  routeId: string
  driverId: string
  truckId: string
}

/**
 * Route, driver and truck of a new or edited shipment, checked, with the goods and waybill options of
 * the route. A waybill already on RS.ge keeps its goods and options while the route stays the same (a
 * later change to the route doesn't rewrite it); otherwise they are the route's as it is now.
 */
async function parseShipment(body: Partial<NewShipmentInput>, user: User, prev?: Shipment) {
  const d = db.get()
  const route = d.routes.find((x) => x.id === str(body.routeId))
  if (!route || !routeLive(d.carriers, route)) return fail('მარშრუტი ვერ მოიძებნა ან წაშლილია')
  if (!canUseCarrier(user, route.carrierId)) fail('ოპერატორს შეუძლია მხოლოდ მისთვის მინიჭებული კარიერების გამოყენება', 403)
  const input = { carrierId: route.carrierId, routeId: route.id, driverId: str(body.driverId), truckId: str(body.truckId) }
  const same = !!prev?.rsWaybillId && prev.routeId === route.id && prev.items.length > 0
  if (!same && !route.goods?.length) fail('ამ მარშრუტზე პროდუქტები ჯერ არ არის მითითებული — მიმართე ადმინისტრატორს')
  // Always შიდა გადაზიდვა.
  const kept = same && prev!.waybill ? { ...prev!.waybill, type: 1 as const, buyerTin: '', buyerName: '', buyerForeign: false } : undefined
  const content = routeContent(route, prev, kept && { items: prev!.items, waybill: kept })
  // A driver or truck kept from before may have been deleted since; a new pick must be live.
  const usable = <T extends { id: string; deletedAt?: string }>(xs: T[], id: string, was?: string) => xs.some((x) => x.id === id && (!x.deletedAt || id === was))
  if (!usable(d.drivers, input.driverId, prev?.driverId)) fail('აირჩიე მძღოლი')
  // Trucks are RS.ge's car numbers (with the model and trailer stored here).
  if (!usable(trucksView(d.trucks), input.truckId, prev?.truckId)) fail('აირჩიე მანქანა')
  return { ...input, ...content }
}

/**
 * The goods, quantity and waybill options a shipment on this route sends: `kept` ones, else the route's
 * as they are now. A planned start already set on the shipment stays while it is ahead.
 */
function routeContent(route: CarrierRoute, prev: Pick<Shipment, 'waybill'> | undefined, kept?: { items: ShipmentItem[]; waybill: ShipmentWaybill }) {
  const items = kept?.items ?? route.goods.map((g) => ({ ...g }))
  const quantity = Math.round(items.reduce((a, i) => a + i.quantity, 0) * 1000) / 1000
  const { beginAt: _b, ...rest } = kept?.waybill ?? waybillDefaults(route)
  const beginAt = prev?.waybill?.beginAt && Date.parse(prev.waybill.beginAt) > Date.now() ? prev.waybill.beginAt : undefined
  const waybill: ShipmentWaybill = { ...rest, ...(beginAt && { beginAt }) }
  return { items, quantity, waybill }
}

/** The shipment's items with what was sent to RS.ge (a product may have been renamed since the shipment was made). */
function sentItems(s: Shipment, payload: RsWaybillPayload): ShipmentItem[] {
  return s.items.map((i, k) => {
    const g = payload.goods[k]
    return { ...i, name: g.name, barCode: g.barCode, unitId: g.unitId, unitTxt: g.unitTxt, price: g.price, vatType: g.vatType, aId: g.aId }
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
function describeEdit(d: StoredDatabase, a: Shipment, b: Pick<Shipment, 'routeId' | 'driverId' | 'truckId' | 'items' | 'quantity' | 'waybill'>) {
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
  /** Creates the record and starts the upload pipeline in the background: the waybill is saved and activated at once. */
  async create(body: Partial<NewShipmentInput>, user: User): Promise<string> {
    if (user.role === 'report') fail('რეპორტ მომხმარებელს არ შეუძლია რეისის შექმნა', 403)
    const notReady = await rsNotReady()
    if (notReady) fail(notReady)
    const x = await parseShipment(body, user)
    x.truckId = truckRecord(x.truckId)
    const sid = uid('s')
    const s: Shipment = {
      id: sid,
      createdAt: nowIso(),
      createdBy: user.id,
      ...x,
      rsWaybill: buildWaybill(db.get(), { ...x, id: sid }),
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
    if (user) noReport(user)
    if (running.has(id)) return
    running.add(id)
    try {
      await runPipeline(id)
    } finally {
      running.delete(id)
    }
    // Activated, the driver texted: with WAYBILL_AUTO_CLOSE=0:00 it is completed now, not at the next check.
    if (AUTO_CLOSE_MS === 0) void autoClose()
  },

  /**
   * Activates a waybill saved as a draft: from now, or from `beginAt` (up to 3 days ahead). The
   * pipeline then activates it and texts the driver.
   */
  async activate(id: string, body: { beginAt?: string } | undefined, user: User) {
    const s = await current(id, user)
    noReport(user)
    if (s.status !== 'saved' || s.waybillState) fail('ზედნადები არ არის შენახულ (გაუაქტიურებელ) მდგომარეობაში')
    if (running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    const beginAt = parseBegin(body?.beginAt)
    // The start asked for is stored until the activation is done (the pipeline reads it).
    patch(
      id,
      () => ({ draft: undefined, status: 'uploading', rs: { status: 'pending' }, waybill: { ...shipmentWaybill(s, resolveRoute(db.get(), s.routeId).route), beginAt } }),
      { level: 'info', message: beginAt ? `მოთხოვნილია გააქტიურება, ტრანსპორტირების დაწყება ${tbilisiTime(beginAt)}` : 'მოთხოვნილია გააქტიურება' },
    )
    void shipments.run(id)
  },

  /**
   * Changes a shipment. Before anything reached RS.ge only the record changes (retry sends it). A
   * draft on RS.ge is overwritten; an active waybill is corrected (კორექტირება), as on the portal: its
   * type and start stay, the rest follows the new route (and its goods and options), driver and truck. The driver
   * is texted again when the driver or truck changed.
   */
  async edit(id: string, body: Partial<NewShipmentInput>, user: User) {
    // RS.ge's copy decides what may change: read it when none is held.
    const s = await current(id, user)
    noReport(user)
    if (running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    if (s.waybillState) fail(s.waybillState === 'closed' ? 'დასრულებულ ზედნადებს ვერ შეცვლი' : 'გაუქმებულ ზედნადებს ვერ შეცვლი')
    if (s.invoiceId) fail('ანგარიშ-ფაქტურაზე მიბმულ ზედნადებს ვერ შეცვლი')
    if (s.status === 'uploading') fail('რეისი ახლა იტვირთება — სცადე ცოტა ხანში')
    if (s.status === 'rs_failed' && !s.rsWaybillId && s.rsSaveAttemptedAt)
      fail('უცნობია, შეინახა თუ არა წინა მცდელობამ ზედნადები RS.ge-ზე — ჯერ დააჭირე „ხელახლა ცდას“')
    const active = s.status === 'uploaded'
    const onRs = !!s.rsWaybillId
    const x = await parseShipment(body, user, s)
    if (active && s.waybill && x.waybill.type !== s.waybill.type) fail('აქტიურ ზედნადებზე ტიპს ვერ შეცვლი (RS.ge)')
    // An active waybill keeps the start RS.ge has.
    if (active) {
      delete x.waybill.beginAt
      if (s.waybill?.beginAt) x.waybill.beginAt = s.waybill.beginAt
    }
    x.truckId = truckRecord(x.truckId)
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
      const now = await rsCache.read(s.rsWaybillId!, id).catch((e: Error) => fail(e.message, 502))
      if (active && now.status !== 1) fail(`RS.ge-ზე ზედნადები ${RS_STATUS_TEXT[now.status] ?? now.status}-ა — შეცვლა შეუძლებელია`)
      if (now.invoiceId) fail('ანგარიშ-ფაქტურაზე მიბმულ ზედნადებს ვერ შეცვლი')
      if (!active && now.status !== 0) fail('RS.ge-ზე ზედნადები უკვე აღარ არის შენახულ მდგომარეობაში — განაახლე გვერდი')
      const begin = active ? (now.beginAt ? new Date(now.beginAt) : new Date()) : (plannedBegin(next) ?? new Date())
      await rsge
        .saveWaybill(payload, id, { id: s.rsWaybillId!, status: active ? 1 : 0, beginDate: rsDate(begin), goods: rowsFor(payload.goods, now) })
        .catch((e: Error) => fail(e.message, 502))
      remote = await rsCache.read(s.rsWaybillId!, id).catch(() => null)
    } finally {
      running.delete(id)
    }
    if (!remote) rsCache.stale(s.rsWaybillId!)
    const message = active ? `ზედნადები №${s.waybillNumber} დაკორექტირდა RS.ge-ზე` : 'RS.ge-ზე შენახული ზედნადები განახლდა'
    // RS.ge has the waybill: what was typed isn't kept (store.ts drops it), RS.ge's copy is shown.
    patch(id, (y) => ({ ...x, rsWaybill: payload, items: sentItems({ ...y, ...x }, payload) }), {
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
    const s = stored(id, user)
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
   * at once, and a refusal because it was already done on the rs.ge portal counts as done. Only an
   * admin does this by hand; without `user` it is the automatic completion (autoClose). `inPipeline`:
   * called from the pipeline (which already holds the shipment), before the driver's only SMS, which
   * then says it is completed: no separate completion SMS.
   */
  async finish(id: string, action: 'close' | 'cancel' | 'delete', user: User | undefined, body?: { deliveredAt?: string }, inPipeline = false) {
    const s = await current(id, user)
    if (user) requireAdmin(user)
    if (action === 'delete') {
      if (s.status !== 'saved' || s.waybillState) fail('წაიშლება მხოლოდ შენახული (გაუაქტიურებელი) ზედნადები')
    } else if (s.status !== 'uploaded') fail('ზედნადები ჯერ არ არის გააქტიურებული')
    if (action === 'close' && s.waybillState) fail(s.waybillState === 'closed' ? 'ზედნადები უკვე დასრულებულია' : 'გაუქმებულ ზედნადებს ვერ დაასრულებ')
    if (action === 'cancel' && s.waybillState === 'cancelled') fail('ზედნადები უკვე გაუქმებულია')
    if (action === 'cancel' && s.invoiceId) fail('ანგარიშ-ფაქტურაზე მიბმულ ზედნადებს RS.ge ვერ გააუქმებს — ჯერ გააუქმე ფაქტურა RS.ge-ს პორტალზე')
    if (!s.rsWaybillId) fail('ზედნადების RS.ge ID უცნობია — დაასრულე ან გააუქმე RS.ge-ს პორტალიდან')
    if (!inPipeline && running.has(id)) fail('რეისი ახლა მუშავდება — სცადე ცოტა ხანში')
    const delivered = action === 'close' ? parseDelivered(body?.deliveredAt) : undefined
    const target = action === 'close' ? 'closed' : 'cancelled'
    let error: Error | undefined
    let w: RsRemoteWaybill | null = null
    if (!inPipeline) running.add(id)
    try {
      try {
        if (action === 'close') await rsge.closeWaybill(s.rsWaybillId!, id, delivered)
        else if (action === 'cancel') await rsge.cancelWaybill(s.rsWaybillId!, id)
        else await rsge.deleteWaybill(s.rsWaybillId!, id)
      } catch (e) {
        error = e as Error
      }
      w = await rsCache.read(s.rsWaybillId!, id).catch(() => null)
    } finally {
      if (!inPipeline) running.delete(id)
    }
    // Not read back: read again soon, so the state shown follows.
    if (!w) rsCache.stale(s.rsWaybillId!)
    if (error && (!w || stateOf(w.status) !== target)) {
      patch(id, () => ({}), { level: 'error', message: error.message })
      fail(error.message, 502)
    }
    if (error) return
    patch(id, () => ({}), {
      level: 'success',
      message:
        action === 'close'
          ? `ზედნადები №${s.waybillNumber} ${user ? '' : 'ავტომატურად '}დასრულდა RS.ge-ზე`
          : action === 'cancel'
            ? `ზედნადები №${s.waybillNumber} გაუქმდა RS.ge-ზე`
            : `RS.ge-ზე შენახული ზედნადები (ID ${s.rsWaybillId}) წაიშალა`,
    })
    // Completed from here (not on the rs.ge portal): the driver is told.
    if (action === 'close' && !inPipeline) await sendDoneSms(id, w?.closedAt ?? nowIso())
  },

  /**
   * Writes a tax invoice (ანგარიშ-ფაქტურა) from the waybill on RS.ge. Not for შიდა გადაზიდვა (no sale).
   * If RS.ge refuses because one exists already (written on the portal), that one is recorded.
   */
  async invoice(id: string, user: User) {
    const s = await current(id, user)
    noReport(user)
    if (s.status !== 'uploaded' || s.waybillState === 'cancelled') fail('ანგარიშ-ფაქტურა იწერება მხოლოდ აქტიურ ან დასრულებულ ზედნადებზე')
    if ((s.rsRemote?.type ?? s.waybill?.type ?? 1) === 1) fail('შიდა გადაზიდვაზე ანგარიშ-ფაქტურა არ იწერება')
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
      const w = await rsCache.read(s.rsWaybillId!, id).catch(() => null)
      if (!w) rsCache.stale(s.rsWaybillId!)
      inv ??= w?.invoiceId
      if (!inv) {
        patch(id, () => ({}), { level: 'error', message: error?.message ?? 'ანგარიშ-ფაქტურა ვერ გამოიწერა' })
        fail(error?.message ?? 'ანგარიშ-ფაქტურა ვერ გამოიწერა', 502)
      }
      patch(id, () => ({}), { level: 'success', message: `ანგარიშ-ფაქტურა გამოიწერა RS.ge-ზე (ID ${inv})` })
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
    const s = stored(id, user)
    if (!s.rsWaybillId) return
    const held = rsCache.waybill(s.rsWaybillId)
    if (held && Date.now() - Date.parse(held.checkedAt) < REFRESH_FRESH_MS) return
    if (!storedCreds()) fail('RS.ge არ არის დაკავშირებული — ზედნადების მონაცემები RS.ge-დან ვერ წაიკითხება', 409)
    await rsCache.read(s.rsWaybillId, id, 'page').catch((e: Error) => fail(e.message, 502))
  },

  /**
   * Reads the waybills of these shipments from RS.ge in the background, the ones not held yet. Lists
   * and reports ask for what they show; the answers arrive with the next state poll.
   */
  loadFromRs(body: { ids?: unknown } | undefined, user: User) {
    if (!storedCreds()) return
    const ids = new Set(Array.isArray(body?.ids) ? body.ids.slice(0, 2000).map(String) : [])
    const waybills = db
      .get()
      .shipments.filter((s) => ids.has(s.id) && s.rsWaybillId && canUseCarrier(user, s.carrierId))
      // Newest first: what is on top of a list arrives first.
      .map((s) => s.rsWaybillId!)
    rsCache.want(waybills)
  },

  /** Asks smsoffice.ge whether the driver got the SMS (opening a shipment calls this). */
  async refreshSms(id: string, user: User) {
    get(id, user)
    await checkDelivery(id).catch((e: Error) => fail(e.message, 502))
  },

  /** On server start: finish pipelines interrupted by a restart, and start completing waybills on time. */
  resumeAll() {
    db.get()
      .shipments.filter((s) => s.status === 'uploading' || s.sms.status === 'running' || (s.status === 'uploaded' && s.sms.status === 'pending'))
      .forEach((s) => void shipments.run(s.id))
    if (AUTO_CLOSE_MS !== null) {
      void autoClose()
      setInterval(() => void autoClose(), AUTO_CLOSE_CHECK_MS).unref()
    }
  },
}

/* ------------------------- Automatic completion ------------------------- */

/** How often active waybills are checked for being due (WAYBILL_AUTO_CLOSE). */
const AUTO_CLOSE_CHECK_MS = 60_000
/** A completion RS.ge refused is not tried again sooner than this. */
const AUTO_CLOSE_RETRY_MS = 30 * 60_000
const autoCloseFailed = new Map<string, number>()
let autoClosing = false
/** Asked for while a pass was running: another pass follows it. */
let autoCloseAgain = false

/** When transport started (or is planned to): RS.ge's start, the one asked for, else when the waybill was activated. */
const transportStart = (s: Shipment) => Date.parse(s.rsRemote?.beginAt ?? s.waybill?.beginAt ?? s.rs.at ?? '')

/**
 * Completes on RS.ge every active waybill whose transport started WAYBILL_AUTO_CLOSE ago or more. Each
 * is read from RS.ge first: one completed or cancelled on the rs.ge portal meanwhile is left alone.
 */
async function autoClose(): Promise<void> {
  if (AUTO_CLOSE_MS === null || !storedCreds()) return
  if (autoClosing) {
    autoCloseAgain = true
    return
  }
  autoClosing = true
  autoCloseAgain = false
  const after = AUTO_CLOSE_MS
  try {
    const now = Date.now()
    const due = db
      .get()
      .shipments.map((s) => withRs(s))
      .filter((s) => s.status === 'uploaded' && !s.waybillState && s.rsWaybillId && !running.has(s.id) && transportStart(s) + after <= now)
      .filter((s) => now - (autoCloseFailed.get(s.id) ?? 0) >= AUTO_CLOSE_RETRY_MS)
    for (const s of due) {
      const w = await rsCache.read(s.rsWaybillId!, s.id).catch(() => null)
      if (!w || w.status !== 1) continue
      // A planned start RS.ge has moved later: due later.
      if (Date.parse(w.beginAt ?? '') + after > Date.now()) continue
      await shipments.finish(s.id, 'close', undefined).then(
        () => autoCloseFailed.delete(s.id),
        () => autoCloseFailed.set(s.id, Date.now()),
      )
    }
  } finally {
    autoClosing = false
  }
  if (autoCloseAgain) return autoClose()
}

/* ------------------------- RS.ge read-back ------------------------- */

/** A waybill read less than this long ago is not read again when the shipment is opened. */
const REFRESH_FRESH_MS = 15_000

const RS_STATUS_TEXT: Record<number, string> = { 0: 'შენახული', 1: 'აქტიური', 2: 'დასრულებული', 8: 'გადამზიდავთან გადაგზავნილი', [-1]: 'წაშლილი', [-2]: 'გაუქმებული' }

/**
 * Runs for every waybill read from RS.ge that belongs to a shipment (`prev`: the copy held before, if
 * any). Nothing of RS.ge's is stored; this only writes our side: a draft activated on the rs.ge portal
 * becomes uploaded here (with its number) and its driver is texted, and changes made on the portal go
 * into the shipment's history.
 */
function reconcile(id: string, prev: RsRemoteWaybill | undefined, w: RsRemoteWaybill) {
  // A pipeline or close/cancel in progress records its own outcome.
  if (running.has(id)) return
  const s = db.get().shipments.find((x) => x.id === id)
  if (!s || (s.status !== 'uploaded' && s.status !== 'saved')) return
  if (s.status === 'saved') {
    if (w.status > 0 && w.number) {
      patch(id, () => ({ status: 'uploaded', draft: undefined, waybillNumber: w.number, rs: { status: 'ok', at: nowIso() } }), {
        level: 'success',
        message: `ზედნადები №${w.number} გააქტიურდა RS.ge-ზე`,
      })
      void shipments.run(id)
    } else if (w.status < 0 && (!prev || prev.status >= 0)) {
      // Said once: after a restart there is no earlier copy to tell it from.
      const message = 'RS.ge-ზე შენახული ზედნადები წაიშალა'
      if (!s.events.some((e) => e.message === message)) patch(id, () => ({}), { level: 'info', message })
    }
    return
  }
  if (!s.waybillNumber && w.number) patch(id, () => ({ waybillNumber: w.number }))
  // Changes are told against the copy read before (none after a restart: nothing to compare with).
  if (!prev) return
  const changes: string[] = []
  if (stateOf(w.status) !== stateOf(prev.status)) changes.push(`სტატუსი: ${RS_STATUS_TEXT[w.status] ?? w.status}`)
  if (plateKey(w.carNumber) !== plateKey(prev.carNumber)) changes.push(`მანქანა: ${prev.carNumber || '—'} → ${w.carNumber || '—'}`)
  if (w.driverTin !== prev.driverTin) changes.push(`მძღოლი: ${prev.driverName || prev.driverTin} → ${w.driverName || w.driverTin}`)
  if (w.startAddress.trim() !== prev.startAddress.trim()) changes.push(`დაწყების მისამართი: ${w.startAddress || '—'}`)
  if (w.endAddress.trim() !== prev.endAddress.trim()) changes.push(`დასრულების მისამართი: ${w.endAddress || '—'}`)
  if (w.quantity !== prev.quantity) changes.push(`რაოდენობა: ${prev.quantity} → ${w.quantity}`)
  if (Math.abs(w.fullAmount - prev.fullAmount) >= 0.005) changes.push(`თანხა: ${prev.fullAmount.toFixed(2)} → ${w.fullAmount.toFixed(2)} ₾`)
  if (w.invoiceId && w.invoiceId !== prev.invoiceId) changes.push(`ანგარიშ-ფაქტურა: ID ${w.invoiceId}`)
  if (changes.length) patch(id, () => ({}), { level: 'info', message: `RS.ge-ზე შეიცვალა — ${changes.join('; ')}` })
}
rsCache.onWaybill(reconcile)

async function runPipeline(id: string) {
  let s = stored(id)

  // 1. RS.ge — save the waybill (→ ID), then activate it (→ number); a draft stops after saving.
  if (s.rs.status !== 'ok') {
    if (s.status === 'rs_failed') patch(id, () => ({}), { level: 'info', message: 'RS.ge-ზე ატვირთვის ხელახალი ცდა' })
    patch(id, () => ({ status: 'uploading', rs: { status: 'running' } }))
    try {
      const notReady = await rsNotReady()
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
      if (!done && stored(id).draft) {
        // RS.ge's copy is what the shipment shows from now on: read it before the typed values are dropped.
        await rsCache.read(waybillId, id).catch(() => rsCache.stale(waybillId!))
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
      // RS.ge's copy is what the shipment shows from now on: read it before the typed values are dropped.
      const wid = waybillId
      await rsCache.read(wid, id).catch(() => rsCache.stale(wid))
      patch(
        id,
        () => ({ status: 'uploaded', draft: undefined, waybillNumber: number || undefined, rs: { status: 'ok', at: nowIso() } }),
        {
          level: 'success',
          message:
            status === 8
              ? `ზედნადები${number ? ` №${number}` : ''} გადაეგზავნა გადამზიდავს — მძღოლს და მანქანას ის მიუთითებს და გაააქტიურებს`
              : `RS.ge-მ დააბრუნა ზედნადები №${number}${state ? ` (RS.ge-ზე უკვე ${RS_STATUS_TEXT[status]})` : ''}`,
        },
      )
    } catch (e) {
      const msg = (e as Error).message
      patch(id, () => ({ status: 'rs_failed', rs: { status: 'failed', error: msg, at: nowIso() } }), { level: 'error', message: msg })
      return
    }
  }

  // 2. SMS to driver (a waybill without transport has none)
  s = stored(id)
  if (s.status !== 'uploaded') return
  if (!s.driverId) {
    if (s.sms.status === 'pending') patch(id, () => ({ sms: { status: 'skipped' } }))
    return
  }
  if (s.sms.status === 'ok') return
  // WAYBILL_AUTO_CLOSE=0:00 and transport has started: completed first, so the driver gets one SMS
  // saying so. If that fails, the usual SMS goes and autoClose completes it later (with its own SMS).
  if (AUTO_CLOSE_MS === 0) {
    const a = get(id)
    if (!a.waybillState && a.rsWaybillId && transportStart(a) <= Date.now()) await shipments.finish(id, 'close', undefined, undefined, true).catch(() => {})
  }
  await sendSms(id)
}

/**
 * Saves a new waybill for the shipment and returns its ID. Built from the current settings and
 * reference data: nothing exists on RS.ge yet, so whatever the admin fixed after a refusal applies.
 */
async function saveNew(id: string): Promise<number> {
  // With RS.ge's copy filled in: a draft deleted on the portal is saved again from what RS.ge had.
  let s = get(id)
  // Nothing reached RS.ge yet: the route's goods and options as they are now, so an admin's fix to the
  // route applies to the retry. (Older shipments of another waybill type keep what they had.)
  const route = db.get().routes.find((r) => r.id === s.routeId)
  if (!s.rsWaybillId && route?.goods?.length && (s.waybill?.type ?? 1) === 1) s = { ...s, ...routeContent(route, s) }
  const payload = buildWaybill(db.get(), s)
  // Recorded before the call: from here on, a lost answer means "maybe saved".
  // The items keep what was sent (a product may have been renamed since the shipment was created).
  patch(id, () => ({ rsWaybill: payload, items: sentItems(s, payload), quantity: s.quantity, ...(s.waybill && { waybill: s.waybill }), rsSaveAttemptedAt: nowIso() }))
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
    // The stored start: the one asked for with this activation (or typed for the shipment).
    return { number: await rsge.sendWaybill(waybillId, id, plannedBegin(stored(id))), status: 1 }
  } catch (e) {
    const w = await rsCache.read(waybillId, id).catch(() => null)
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
    // Read through the cache: a shipment's waybill is then shown (and its changes noticed) there too.
    const w = await rsCache.read(waybillId, sid, 'page').catch((e: Error) => fail(e.message, 502))
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
      const call = <T,>(p: Promise<T>) => p.catch((e: Error) => fail(e.message, 502))
      if (action === 'close') await call(rsge.closeWaybill(waybillId, undefined, parseDelivered(body?.deliveredAt)))
      else if (action === 'cancel') await call(rsge.cancelWaybill(waybillId, undefined))
      else if (action === 'delete') await call(rsge.deleteWaybill(waybillId, undefined))
      else if (action === 'activate') {
        const begin = parseBegin(body?.beginAt)
        const w = await call(rsCache.read(waybillId, undefined))
        const send = w.transporterTin ? rsge.sendToTransporter : rsge.sendWaybill
        await call(send(waybillId, undefined, begin ? new Date(begin) : undefined))
      } else if (action === 'invoice') await call(rsge.saveInvoice(waybillId, undefined))
      else if (action === 'confirm' || action === 'reject') await call(rsge.answer(waybillId, action === 'confirm'))
      else fail('უცნობი მოქმედება', 404)
    }
    return rsWaybills.get(waybillId, user)
  },
}

const smsUndelivered = (s: Shipment) => s.sms.delivery === 'Undelivered' || s.sms.delivery === 'Expired'

/** `DD.MM.YYYY HH:MM` in Georgian time. */
function smsDate(iso: string) {
  const [day, time] = tbilisiStamp(iso).split(' ')
  return `${day.split('-').reverse().join('.')} ${time}`
}

const smsMoney = (n: number) => `${n.toFixed(2)} ₾`
const smsQty = (n: number) => String(Math.round(n * 1000) / 1000)
const smsParty = (name?: string, tin?: string) => [name, tin].filter(Boolean).join(', ')

/**
 * The driver's SMS: the whole waybill as RS.ge has it (w), in blocks split by blank lines: its number,
 * route, driver and vehicle, goods, the rest. Empty lines are left out, and so is what is always the
 * same (საავტომობილო transport, ordinary VAT). Without RS.ge's copy (it couldn't be read) the head is
 * written from the shipment and the goods, which only RS.ge holds once the waybill is there, are left out.
 */
function smsText(s: Shipment, d: StoredDatabase, w: RsRemoteWaybill | undefined): string {
  const route = resolveRoute(d, s.routeId)
  const driver = d.drivers.find((x) => x.id === s.driverId)
  const truck = d.trucks.find((x) => x.id === s.truckId)
  const rs = rsView()
  const type = w?.type ?? s.waybill?.type ?? 1
  const seller = smsParty(w?.sellerName || rs.sellerName, w?.sellerTin || rs.sellerTin)
  // შიდა გადაზიდვა: the buyer is the seller.
  const buyer = w ? smsParty(w.buyerName, w.buyerTin) : type === 1 ? seller : smsParty(s.waybill?.buyerName, s.waybill?.buyerTin)
  const begin = w?.beginAt ?? s.waybill?.beginAt ?? w?.activatedAt
  // RS.ge keeps plates without dashes: the truck's own spelling when it is the same plate.
  const car = w ? (truck && plateKey(truck.plateNumber) === plateKey(w.carNumber) ? truck.plateNumber : w.carNumber) : truck?.plateNumber
  const transId = w?.transId ?? RS_TRANS_CAR
  const cost = w?.transportCost ?? s.waybill?.transportCost ?? 0
  const akciz = rsge.account()?.akciz
  const units = new Set(w?.goods.map((g) => g.unitTxt))
  const line = (label: string, value: string | false | undefined) => value && `${label}: ${value}`
  const blocks: (string | false | undefined)[][] = [
    [w?.status === 2 ? `ზედნადები №${s.waybillNumber} დასრულებულია ${smsDate(w.closedAt ?? nowIso())}.` : `ზედნადები №${s.waybillNumber} გააქტიურებულია.`],
    [w?.startAddress || route.start, `→ ${w?.endAddress || route.end}`, line('დაწყება', begin && smsDate(begin))],
    [
      line('მძღოლი', w ? smsParty(w.driverName, w.driverTin) : driver && smsParty(`${driver.firstName} ${driver.lastName}`, driver.personalId)),
      line('მანქანა', car),
      line('მისაბმელი', truck?.trailerNumber),
      line('ტრანსპორტი', transId !== RS_TRANS_CAR && (w?.transTxt || `ტიპი ${transId}`)),
      line('გადამზიდავი', w?.transporterTin),
    ],
    [
      ...(w?.goods ?? []).flatMap((g, i) => {
        const vat = g.vatType ? RS_VAT_TYPES.find((v) => v.value === g.vatType)?.label : undefined
        const a = g.aId ? akciz?.find((x) => x.id === g.aId) : undefined
        return [
          `${i + 1}) ${[g.name, g.barCode].filter(Boolean).join(' · ')}`,
          `${smsQty(g.quantity)} ${g.unitTxt} × ${g.price.toFixed(2)} = ${smsMoney(g.amount)}`,
          line('დამატებითი რაოდენობა', !!g.quantityExt && smsQty(g.quantityExt)),
          line('დღგ', vat),
          line('აქციზი', !!g.aId && (a ? `${a.code} ${a.title}` : String(g.aId))),
        ]
      }),
      !!w?.goods.length && `სულ: ${smsQty(w.quantity)}${units.size === 1 ? ` ${[...units][0]}` : ''} · ${smsMoney(w.fullAmount)}`,
    ],
    [
      line('ტრანსპორტირება', cost > 0 && smsMoney(cost)),
      ...(seller === buyer ? [line('გამყიდველი და მყიდველი', seller)] : [line('გამყიდველი', seller), line('მყიდველი', buyer)]),
      line('ჩაბარების ინფო', w?.receptionInfo ?? s.waybill?.receptionInfo),
      line('მიმღები', w?.receiverInfo ?? s.waybill?.receiverInfo),
      line('კომენტარი', w ? typedComment(w.comment, s.id) : s.waybill?.comment),
    ],
  ]
  return blocks
    .map((b) => b.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
}

/** "ზედნადები №… დასრულებულია DD.MM.YYYY HH:MM." to the driver; the outcome goes into the shipment's history. */
async function sendDoneSms(id: string, closedAt: string) {
  const s = stored(id)
  const driver = db.get().drivers.find((x) => x.id === s.driverId)
  if (!driver) return
  const text = `ზედნადები №${s.waybillNumber} დასრულებულია ${smsDate(closedAt)}.`
  const c = smsCreds()
  const destination = toDestination(driver.phone)
  const failed = (msg: string) => patch(id, () => ({}), { level: 'error', message: `დასრულების SMS ვერ გაიგზავნა: ${msg}` })
  if (!c) return failed('SMS-ის პარამეტრები არ არის შევსებული')
  if (!destination) return failed(`მძღოლის ნომერი (${driver.phone}) არ არის ქართული მობილურის ნომერი`)
  try {
    await smsoffice.send(c, destination, text, newReference(), id)
    patch(id, () => ({}), { level: 'success', message: `მძღოლს გაეგზავნა დასრულების SMS (${driver.phone})` })
  } catch (e) {
    failed((e as Error).message)
  }
}

async function sendSms(id: string) {
  const s = get(id)
  const d = db.get()
  const driver = d.drivers.find((x) => x.id === s.driverId)
  if (!driver) return void patch(id, () => ({ sms: { status: 'skipped' } }))
  // RS.ge's copy is normally held since activation; after a restart it is read now.
  const w = s.rsRemote ?? (s.rsWaybillId && storedCreds() ? await rsCache.read(s.rsWaybillId, id).catch(() => undefined) : undefined)
  const text = smsText(s, d, w)
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
  const s = stored(id)
  const { status, reference, destination, delivery, deliveryCheckedAt, at } = s.sms
  if (status !== 'ok' || !reference || !destination || (delivery && SMS_FINAL.includes(delivery))) return Promise.resolve()
  if (deliveryCheckedAt && Date.now() - Date.parse(deliveryCheckedAt) < DELIVERY_FRESH_MS) return Promise.resolve()
  if (at && Date.now() - Date.parse(at) > DELIVERY_MAX_AGE_MS) return Promise.resolve()
  let p = checkingSms.get(id)
  if (!p) {
    p = smsDelivery(destination, reference, id).then((now) => {
      // Only if this is still the same message (not re-sent meanwhile).
      if (!now || stored(id).sms.reference !== reference) return
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
