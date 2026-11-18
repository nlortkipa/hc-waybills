import { defaultRsSettings } from '../src/lib/rs.ts'
import { defaultSmsSettings } from '../src/lib/sms.ts'
import type { Carrier, CarrierRoute, Database, Product, RsSettings, Shipment, User } from '../src/types.ts'

export const DB_VERSION = 20

/** Empty database: only the admin exists (logs in with 575780323); everything else, including other users, is added through the app. */
export function createSeed(): Database {
  const users = [
    { id: 'u1', firstName: 'ადმინი', lastName: 'HC', phone: '575 78 03 23', email: 'admin@hc.ge', role: 'admin' as const },
  ]

  return {
    version: DB_VERSION,
    carriers: [],
    routes: [],
    drivers: [],
    trucks: [],
    // Products come from RS.ge (the first sync reads the taxpayer's list) or are added by the admin.
    products: [],
    users,
    shipments: [],
    logs: [],
    rs: defaultRsSettings(),
    sms: defaultSmsSettings(),
  }
}

type V15Destination = { id: string; address: string; scaleId: string; deletedAt?: string }
type V15Carrier = Carrier & { destinations?: V15Destination[] }
type V15Route = Omit<CarrierRoute, 'endAddress' | 'scaleId' | 'productId'> & { destinationId: string }

/** Upgrades an older stored database in place instead of starting over. Returns null if it can't. */
export function migrate(db: Database): Database | null {
  let d = db as Database & { version: number }
  // v9 → v10: RS.ge settings added.
  if (d.version === 9) d = { ...d, version: 10, rs: defaultRsSettings() }
  // v10 → v11: RS.ge simulator and mode removed. IDs from the simulator mean nothing to RS.ge, so drop them.
  if (d.version === 10) {
    const { mode: _m, spSet: _ss, ...rs } = d.rs as Database['rs'] & { mode?: string }
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
  if (d.version === 11) d = { ...d, version: 12, rs: { ...d.rs, su: d.rs.su ?? '', sp: d.rs.sp ?? '' } }
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
    d = { ...d, version: 16, rs }
  }
  // v16 → v17: real SMS through smsoffice.ge (it was mocked); the account starts empty.
  if (d.version === 16) d = { ...d, version: 17, sms: defaultSmsSettings() }
  // v17 → v18: end addresses move off the carrier onto the route, typed there with their scale ID.
  // Each route takes over the end address it pointed at; shipments keep their routeId.
  if (d.version === 17) {
    const carriers = d.carriers as unknown as V15Carrier[]
    const dest = (carrierId: string, id: string) => carriers.find((c) => c.id === carrierId)?.destinations?.find((x) => x.id === id)
    const routes: CarrierRoute[] = (d.routes as unknown as V15Route[]).map(({ destinationId, ...r }) => {
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
    d = { ...d, version: 18, carriers: carriers.map(({ destinations: _x, ...c }) => c), routes, shipments }
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
      rs: { ...rs, quantity: cargo?.quantity ?? 0 },
      shipments: d.shipments.map((s) => ({ ...s, productId: p && s.cargo.description === p.name && s.cargo.code === p.barCode ? p.id : '' })),
    }
  }
  // v19 → v20: the product moves from the shipment form onto the route. Each route takes the product
  // its latest shipment used, or the only product when there is just one; otherwise the admin picks it.
  if (d.version === 19) {
    const live = new Set(d.products.filter((p) => !p.deletedAt).map((p) => p.id))
    const only = live.size === 1 ? [...live][0] : ''
    const used = (routeId: string) => d.shipments.find((s) => s.routeId === routeId && live.has(s.productId))?.productId
    d = { ...d, version: 20, routes: d.routes.map((r) => ({ ...r, productId: r.productId || used(r.id) || only })) }
  }
  return d.version === DB_VERSION ? d : null
}
