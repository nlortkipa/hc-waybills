import { defaultRsSettings } from '../src/lib/rs.ts'
import type { Carrier, Database, Shipment, User } from '../src/types.ts'

export const DB_VERSION = 16

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
    users,
    shipments: [],
    logs: [],
    cargo: { description: 'ღორღი 0–5 მმ', code: 'CRS-05', quantity: 25 },
    rs: defaultRsSettings(),
  }
}

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
    type AnyCarrier = Carrier & { routes?: V14Route[] }
    const carriers: Carrier[] = (d.carriers as AnyCarrier[]).map(({ routes, ...c }) => {
      if (!routes) return c // a v13 carrier: already in this shape
      const start = (routes.find((x) => !x.deletedAt) ?? routes[0])?.startAddress ?? ''
      return { ...c, startAddress: start, destinations: routes.map((x) => ({ id: x.id, address: x.endAddress, scaleId: x.scaleId, ...(x.deletedAt ? { deletedAt: x.deletedAt } : {}) })) }
    })
    d = {
      ...d,
      version: 15,
      carriers,
      routes: carriers.flatMap((c) =>
        c.destinations.map((x) => {
          const deletedAt = x.deletedAt ?? c.deletedAt
          return { id: x.id, carrierId: c.id, destinationId: x.id, ...(deletedAt ? { deletedAt } : {}) }
        }),
      ),
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
  return d.version === DB_VERSION ? d : null
}
