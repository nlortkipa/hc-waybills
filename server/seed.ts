import { defaultRsSettings } from '../src/lib/rs.ts'
import { defaultSmsSettings } from '../src/lib/sms.ts'
import type { Carrier, CarrierRoute, Database, Product, RsSettings, Scale, Shipment, ShipmentItem, ShipmentWaybill, StoredDatabase, User } from '../src/types.ts'
import { uid } from '../src/lib/util.ts'

export const DB_VERSION = 31

/**
 * A shipment as it is stored. What RS.ge reports is never stored; what was typed for the waybill is
 * dropped once RS.ge has the waybill (it is read from RS.ge from then on).
 */
export function storedShipment(s: Shipment): Shipment {
  const { rsRemote: _r, waybillState: _w, invoiceId: _i, ...rest } = s
  if (rest.rsWaybillId && rest.rs.status === 'ok' && (rest.status === 'saved' || rest.status === 'uploaded')) {
    const { items: _a, quantity: _q, waybill: _b, rsWaybill: _p, ...thin } = rest
    return thin as Shipment
  }
  return rest
}

/** Empty database: only the admin exists (logs in with 575780323); everything else, including other users, is added through the app. */
export function createSeed(): StoredDatabase {
  const users = [
    { id: 'u1', firstName: 'ადმინი', lastName: 'HC', phone: '575 78 03 23', email: 'admin@hc.ge', role: 'admin' as const },
  ]

  return {
    version: DB_VERSION,
    carriers: [],
    routes: [],
    scales: [],
    drivers: [],
    trucks: [],
    users,
    shipments: [],
    logs: [],
    rs: defaultRsSettings(),
    sms: defaultSmsSettings(),
  }
}

type V15Destination = { id: string; address: string; scaleId: string; deletedAt?: string }
type V15Carrier = Carrier & { destinations?: V15Destination[] }
type V15Route = Omit<CarrierRoute, 'endAddress' | 'scaleId' | 'goods'> & { destinationId: string }
/** Before v22: one product per route and per shipment. */
type V21Route = Omit<CarrierRoute, 'goods'> & { productId: string }
type V21Shipment = Omit<Shipment, 'items'> & { productId: string; cargo: { description: string; code: string } }
/** v22: a list of products per route; shipment items without price and VAT. */
type V22Route = Omit<CarrierRoute, 'goods'> & { productIds: string[] }
type V22Item = Omit<ShipmentItem, 'lineId' | 'price' | 'vatType'>
/** v23–v25: routes carried the goods lines; shipment items named the line they came from. */
type V25Good = Omit<ShipmentItem, 'quantity'> & { id: string; productId: string; quantity?: number }
type V25Route = V27Route & { goods: V25Good[] }
type V25Item = ShipmentItem & { lineId?: string; productId?: string }
/** Before v28: routes had their own waybill type and buyer, and (before v27) goods lines of their own shape. */
type V27Route = Omit<CarrierRoute, 'goods'> & { waybillType?: number; buyerTin?: string; buyerName?: string; buyerForeign?: boolean }
/** Before v23 price and VAT type were global settings. */
type V22Rs = RsSettings & { price?: number; vatType?: 0 | 1 | 2 }

/** Upgrades an older stored database in place instead of starting over. Returns null if it can't. */
export function migrate(db: StoredDatabase): StoredDatabase | null {
  // Products were stored before v24: the steps below still see them.
  let d = { products: [], ...db, scales: db.scales ?? [] } as Database & { version: number }
  // v9 → v10: RS.ge settings added.
  if (d.version === 9) d = { ...d, version: 10, rs: defaultRsSettings() }
  // v10 → v11: RS.ge simulator and mode removed. IDs from the simulator mean nothing to RS.ge, so drop them.
  if (d.version === 10) {
    const { mode: _m, spSet: _ss, ...rs } = d.rs as Database['rs'] & { mode?: string; spSet?: boolean }
    d = {
      ...d,
      version: 11,
      rs: { ...rs, sellerUnId: null, sellerUserId: null, sellerTin: '', sellerName: '', checkedAt: undefined },
      shipments: d.shipments.map((s) => {
        const { rsMode: _rm, ...rest } = s as typeof s & { rsMode?: string }
        return rest.rsWaybillId ? { ...rest, rsWaybillId: undefined } : rest
      }),
    }
  }
  // v11 → v12: service user fields back (v11 had none).
  if (d.version === 11) d = { ...d, version: 12, rs: { ...d.rs, su: d.rs.su ?? '' } }
  // v12 → v13: simulation settings (latency, SMS failure rate) removed.
  if (d.version === 12) {
    const { settings: _s, ...rest } = d as Database & { settings?: unknown }
    d = { ...rest, version: 13 }
  }
  // v13 → v14: operators get a list of carriers. (v14 also kept routes inside the carrier; v15 undoes that.)
  if (d.version === 13) {
    d = {
      ...d,
      version: 14,
      users: (d.users as (User & { carrierId?: string })[]).map(({ carrierId, ...u }) => (carrierId ? { ...u, carrierIds: [carrierId] } : u)),
    }
  }
  // v14 → v15: routes are their own records (carrier + one of its end addresses), and carriers have their
  // start address + end addresses again. Every end address gets a route with the same id, so operators keep
  // every route they had and a shipment's routeId (v14) or destinationId (v13) still names both.
  if (d.version === 14) {
    type V14Route = { id: string; startAddress: string; endAddress: string; scaleId: string; deletedAt?: string }
    type AnyCarrier = V15Carrier & { routes?: V14Route[] }
    const carriers: V15Carrier[] = (d.carriers as unknown as AnyCarrier[]).map(({ routes, ...c }) => {
      if (!routes) return c // a v13 carrier: already in this shape
      const start = (routes.find((x) => !x.deletedAt) ?? routes[0])?.startAddress ?? ''
      return { ...c, startAddress: start, destinations: routes.map((x) => ({ id: x.id, address: x.endAddress, scaleId: x.scaleId, ...(x.deletedAt ? { deletedAt: x.deletedAt } : {}) })) }
    })
    d = {
      ...d,
      version: 15,
      carriers: carriers as unknown as Carrier[],
      routes: carriers.flatMap((c) =>
        (c.destinations ?? []).map((x) => {
          const deletedAt = x.deletedAt ?? c.deletedAt
          return { id: x.id, carrierId: c.id, destinationId: x.id, ...(deletedAt ? { deletedAt } : {}) }
        }),
      ) as unknown as CarrierRoute[],
      shipments: (d.shipments as (Shipment & { routeId?: string; destinationId?: string })[]).map((s) => {
        const id = s.destinationId || s.routeId || ''
        return { ...s, routeId: id, destinationId: id }
      }),
    }
  }
  // v15 → v16: waybills are always შიდა გადაზიდვა, whose buyer is the seller: the buyer settings go.
  if (d.version === 15) {
    const { buyerTin: _t, buyerName: _n, buyerForeign: _f, ...rs } = d.rs as typeof d.rs & { buyerTin?: string; buyerName?: string; buyerForeign?: boolean }
    d = { ...d, version: 16, rs: rs as RsSettings }
  }
  // v16 → v17: real SMS through smsoffice.ge (it was mocked); the account starts empty.
  if (d.version === 16) d = { ...d, version: 17, sms: defaultSmsSettings() }
  // v17 → v18: end addresses move off the carrier onto the route, typed there with their scale ID.
  // Each route takes over the end address it pointed at; shipments keep their routeId.
  if (d.version === 17) {
    const carriers = d.carriers as unknown as V15Carrier[]
    const dest = (carrierId: string, id: string) => carriers.find((c) => c.id === carrierId)?.destinations?.find((x) => x.id === id)
    const routes: V21Route[] = (d.routes as unknown as V15Route[]).map(({ destinationId, ...r }) => {
      const x = dest(r.carrierId, destinationId)
      return { ...r, endAddress: x?.address ?? '', scaleId: x?.scaleId ?? '', productId: '' }
    })
    // A shipment whose route record is missing still resolves through its end address.
    const shipments = (d.shipments as (Shipment & { destinationId?: string })[]).map(({ destinationId, ...s }) => {
      const id = s.routeId || destinationId || ''
      const x = destinationId ? dest(s.carrierId, destinationId) : undefined
      if (id && x && !routes.some((r) => r.id === id)) routes.push({ id, carrierId: s.carrierId, endAddress: x.address, scaleId: x.scaleId, productId: '', deletedAt: x.deletedAt ?? new Date().toISOString() })
      return { ...s, routeId: id }
    })
    d = { ...d, version: 18, carriers: carriers.map(({ destinations: _x, ...c }) => c), routes: routes as unknown as CarrierRoute[], shipments }
  }
  // v18 → v19: the one admin-set cargo becomes a product (with the unit from the RS.ge settings), and
  // operators pick a product per shipment. Its declared quantity moves to the RS.ge settings. The
  // first product sync then makes the list equal to RS.ge's (this one stays only if RS.ge has its code).
  if (d.version === 18) {
    type V18 = Database & { cargo?: { description: string; code: string; quantity: number } }
    const { cargo, ...rest } = d as V18 & { version: number }
    const { unitId = 99, unitTxt = 'ტონა', ...rs } = d.rs as RsSettings & { unitId?: number; unitTxt?: string }
    const products: Product[] = cargo?.description.trim() && cargo.code.trim() ? [{ id: 'p1', name: cargo.description.trim(), barCode: cargo.code.trim(), unitId, unitTxt }] : []
    const p = products[0]
    d = {
      ...rest,
      version: 19,
      products,
      rs: { ...rs, quantity: cargo?.quantity ?? 0 } as RsSettings,
      shipments: (d.shipments as unknown as V21Shipment[]).map((s) => ({ ...s, productId: p && s.cargo.description === p.name && s.cargo.code === p.barCode ? p.id : '' })) as unknown as Shipment[],
    }
  }
  // v19 → v20: the product moves from the shipment form onto the route. Each route takes the product
  // its latest shipment used, or the only product when there is just one; otherwise the admin picks it.
  if (d.version === 19) {
    const live = new Set(d.products.filter((p) => !p.deletedAt).map((p) => p.id))
    const only = live.size === 1 ? [...live][0] : ''
    const shipments = d.shipments as unknown as V21Shipment[]
    const used = (routeId: string) => shipments.find((s) => s.routeId === routeId && live.has(s.productId))?.productId
    const routes = (d.routes as unknown as V21Route[]).map((r) => ({ ...r, productId: r.productId || used(r.id) || only }))
    d = { ...d, version: 20, routes: routes as unknown as CarrierRoute[] }
  }
  // v20 → v21: a buyer can be set again; none (the default) keeps შიდა გადაზიდვა.
  if (d.version === 20) d = { ...d, version: 21, rs: { ...d.rs, buyerTin: '', buyerName: '', buyerForeign: false } as RsSettings }
  // v21 → v22: a waybill carries several products. Routes get a list of products, shipments a list of
  // goods lines (each with its own quantity); the settings' quantity is only prefilled from now on.
  if (d.version === 21) {
    const routes = (d.routes as unknown as V21Route[]).map(({ productId, ...r }) => ({ ...r, productIds: productId ? [productId] : [] }))
    const shipments = (d.shipments as unknown as V21Shipment[]).map(({ productId, cargo, ...s }) => {
      const p = d.products.find((x) => x.id === productId)
      // The unit is what the waybill was sent with, else the product's, else tonnes as "other".
      const g = s.rsWaybill?.goods[0]
      const unit = g ? { unitId: g.unitId, unitTxt: g.unitTxt } : p ? { unitId: p.unitId, unitTxt: p.unitTxt } : { unitId: 99, unitTxt: 'ტონა' }
      return { ...s, items: [{ productId, name: cargo.description, barCode: cargo.code, ...unit, quantity: s.quantity }] }
    })
    d = { ...d, version: 22, routes: routes as unknown as CarrierRoute[], shipments: shipments as unknown as Shipment[] }
  }
  // v22 → v23: routes hold goods lines (a product from the list or typed in, with its price and VAT
  // type) instead of product ids; price and VAT type leave the settings for the lines.
  if (d.version === 22) {
    const { price = 0, vatType = 0, ...rs } = d.rs as V22Rs
    const routes: V25Route[] = (d.routes as unknown as V22Route[]).map(({ productIds, ...r }) => ({
      ...r,
      goods: (productIds ?? []).flatMap((id, i) => {
        const p = d.products.find((x) => x.id === id)
        return p ? [{ id: `${r.id}.${i}`, productId: p.id, name: p.name, barCode: p.barCode, unitId: p.unitId, unitTxt: p.unitTxt, price, vatType }] : []
      }),
    }))
    const shipments = d.shipments.map((s) => ({
      ...s,
      items: (s.items as unknown as V22Item[]).map((i, k) => {
        const g = s.rsWaybill?.goods[k]
        return { ...i, lineId: '', price: g?.price ?? price, vatType: g?.vatType ?? vatType }
      }),
    }))
    d = { ...d, version: 23, rs, routes: routes as unknown as CarrierRoute[], shipments }
  }
  // v23 → v24: RS.ge's data is no longer stored. Products go (RS.ge's list is read live, the bar code
  // is a product's id); the seller, reference lists and sync state go from the settings (store.ts drops
  // them on write); shipments already on RS.ge keep only what RS.ge doesn't have.
  if (d.version === 23) {
    const codeOf = (id: string) => d.products.find((p) => p.id === id)?.barCode
    const product = <T extends { productId: string; barCode: string }>(g: T): T => ({ ...g, productId: g.productId && codeOf(g.productId) === g.barCode ? g.barCode : '' })
    const routes = (d.routes as V25Route[]).map((r) => ({ ...r, goods: r.goods.map(product) }))
    const shipments = d.shipments.map((s) => storedShipment({ ...s, items: ((s.items ?? []) as V25Item[]).map((i) => product({ ...i, productId: i.productId ?? '' })) }))
    d = { ...d, version: 24, routes: routes as unknown as CarrierRoute[], shipments }
  }
  // v24 → v25: the quantity prefilled on new shipments is set per goods line of a route, not once in
  // the settings. Every line takes the settings' old value.
  if (d.version === 24) {
    const { quantity = 0, ...rs } = d.rs as RsSettings & { quantity?: number }
    const routes = (d.routes as V25Route[]).map((r) => ({ ...r, goods: r.goods.map((g) => (quantity > 0 ? { ...g, quantity } : g)) }))
    d = { ...d, version: 25, rs, routes: routes as unknown as CarrierRoute[] }
  }
  // v25 → v26: the buyer and transport cost are per waybill, not in the settings. A settings buyer
  // moves onto the routes that had none (and weren't შიდა გადაზიდვა), so their waybills keep it.
  if (d.version === 25) {
    const { buyerTin = '', buyerName = '', buyerForeign = false, transportCost: _c, ...rs } = d.rs as RsSettings & { buyerTin?: string; buyerName?: string; buyerForeign?: boolean; transportCost?: number }
    const own = buyerTin && buyerTin !== rs.sellerTin
    const routes = (d.routes as unknown as V27Route[]).map((r) => (own && !r.buyerTin && r.waybillType !== 1 ? { ...r, buyerTin, buyerName, ...(buyerForeign && { buyerForeign }) } : r))
    d = { ...d, version: 26, rs, routes: routes as unknown as CarrierRoute[] }
  }
  // v26 → v27: the RS.ge settings keep only the service user: everything on a waybill is set per
  // shipment, and the goods are chosen on the shipment instead of the route.
  // - The transport type and transporter go onto the shipments not on RS.ge yet, so retries send the same.
  // - Those shipments' goods lines take their route line as it is now (what a retry used to send).
  if (d.version === 26) {
    type V26Rs = RsSettings & { transId?: number; transTxt?: string; transporterTin?: string }
    const old = d.rs as V26Rs
    const { transId = 1, transTxt = '', transporterTin = '' } = old
    const rs = { ...old } as Record<string, unknown>
    for (const k of ['buyerTin', 'buyerName', 'buyerForeign', 'transId', 'transTxt', 'transporterTin', 'transportCost', 'tranCostPayer', 'receptionInfo', 'receiverInfo', 'comment', 'unitId', 'unitTxt']) delete rs[k]
    const oldRoutes = d.routes as unknown as V25Route[]
    const routes = oldRoutes.map(({ goods: _g, ...r }) => r) as unknown as CarrierRoute[]
    const shipments = d.shipments.map((s) => {
      const items = (s.items as V25Item[] | undefined)?.map(({ lineId, productId: _p, ...i }) => {
        const line = lineId ? oldRoutes.find((r) => r.id === s.routeId)?.goods?.find((g) => g.id === lineId) : undefined
        if (!line) return i
        const { id: _id, productId: _lp, quantity: _q, ...g } = line
        return { ...i, ...g }
      })
      const w = s.waybill as (ShipmentWaybill & { transId?: number; transTxt?: string; transporterTin?: string }) | undefined
      const waybill = w && { ...w, transId: w.transId ?? transId, transTxt: w.transTxt ?? transTxt, transporterTin: w.transporterTin ?? transporterTin }
      return { ...s, ...(items && { items }), ...(waybill && { waybill }) }
    })
    d = { ...d, version: 27, rs: rs as unknown as RsSettings, routes, shipments }
  }
  // v27 → v28: operators pick only the route, driver and truck; the admin sets everything else on the
  // route, and every waybill is შიდა გადაზიდვა. Routes lose their type and buyer and get goods lines:
  // those of the newest shipment on the route whose goods are stored here (else none: the admin sets
  // them before the route can be picked). Shipments not on RS.ge yet keep what they would have sent.
  if (d.version === 27) {
    const newest = [...d.shipments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const routes = (d.routes as unknown as V27Route[]).map(({ waybillType: _t, buyerTin: _b, buyerName: _n, buyerForeign: _f, ...r }) => {
      const items = newest.find((s) => s.routeId === r.id && s.items?.length)?.items ?? []
      return { ...r, goods: items.map((i) => ({ ...i })) }
    })
    d = { ...d, version: 28, routes }
  }
  // v28 → v29: the transport type is always საავტომობილო, paid by the seller. Routes and the shipments'
  // waybill options lose the type, the "other" name, the transporter and the payer; the cost stays.
  if (d.version === 28) {
    const TRANS = ['transId', 'transTxt', 'transporterTin', 'tranCostPayer']
    const drop = <T extends object>(x: T): T => Object.fromEntries(Object.entries(x).filter(([k]) => !TRANS.includes(k))) as T
    const routes = d.routes.map(drop)
    const shipments = d.shipments.map((s) => (s.waybill ? { ...s, waybill: drop(s.waybill) } : s))
    d = { ...d, version: 29, routes, shipments }
  }
  // v29 → v30: the admin (u1) logs in with 575 78 03 23. A database still on the old default number
  // moves to it; another account that held that number is removed (phone numbers are unique).
  if (d.version === 29) {
    const ADMIN_PHONE = '575 78 03 23'
    const key = (p: string) => p.replace(/\D/g, '').replace(/^(00)?995(?=\d{9}$)/, '')
    const admin = d.users.find((u) => u.id === 'u1' && !u.deletedAt)
    const users =
      admin && key(admin.phone) === '555555555'
        ? d.users.map((u) =>
            u.id === 'u1' ? { ...u, phone: ADMIN_PHONE } : !u.deletedAt && key(u.phone) === key(ADMIN_PHONE) ? { ...u, deletedAt: new Date().toISOString() } : u,
          )
        : d.users
    d = { ...d, version: 30, users }
  }
  // v30 → v31: scales are their own records (ID + API address, ცნობარები → სასწორი) and a route
  // points at one. Each scale ID typed on routes becomes a scale without an address (the admin adds it).
  if (d.version === 30) {
    const scales: Scale[] = [...(d.scales ?? [])]
    const byCode = new Map(scales.map((x) => [x.code.trim().toLowerCase(), x]))
    const routes = d.routes.map((r) => {
      const code = String(r.scaleId ?? '').trim()
      if (!code) return { ...r, scaleId: '' }
      let x = byCode.get(code.toLowerCase())
      if (!x) {
        x = { id: uid('w'), code, url: '' }
        scales.push(x)
        byCode.set(code.toLowerCase(), x)
      }
      return { ...r, scaleId: x.id }
    })
    d = { ...d, version: 31, routes, scales }
  }
  if (d.version !== DB_VERSION) return null
  const { products: _p, ...stored } = d
  return stored
}
