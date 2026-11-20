import type { Carrier, CarrierRoute, ShipmentItem, User } from '../types.ts'
import { formatNumber } from './util.ts'

export interface ResolvedRoute {
  carrier?: Carrier
  route?: CarrierRoute
  start: string
  end: string
}

/** Resolves a route's addresses: its carrier's start address and its own end address. */
export function resolveRoute(d: { carriers: Carrier[]; routes: CarrierRoute[] }, routeId: string): ResolvedRoute {
  const route = d.routes.find((x) => x.id === routeId)
  return routeAddresses(d.carriers, route)
}

/** Same as resolveRoute, for a route record already in hand. */
export function routeAddresses(carriers: Carrier[], route: CarrierRoute | undefined): ResolvedRoute {
  const carrier = route && carriers.find((c) => c.id === route.carrierId)
  return { carrier, route, start: carrier?.startAddress ?? '', end: route?.endAddress ?? '' }
}

export const routeText = (r: { start: string; end: string }) => (r.start || r.end ? `${r.start || '—'} → ${r.end || '—'}` : '—')

/** 'Start → End' of a route, as shown in pickers and lists. */
export const routeLabel = (carriers: Carrier[], r: CarrierRoute) => routeText(routeAddresses(carriers, r))

/** A route that still exists, with its carrier. */
export function routeLive(carriers: Carrier[], r: CarrierRoute): boolean {
  const c = carriers.find((x) => x.id === r.carrierId)
  return !r.deletedAt && !!c && !c.deletedAt && !!r.endAddress.trim()
}

/** A route that can be picked for a new shipment: it exists and the admin has set its goods. */
export const routeUsable = (carriers: Carrier[], r: CarrierRoute) => routeLive(carriers, r) && (r.goods?.length ?? 0) > 0

/** Whether a user may see and create shipments of a carrier: operators only their own carriers. */
export const canUseCarrier = (user: User, carrierId: string) => user.role !== 'operator' || (user.carrierIds ?? []).includes(carrierId)

/** Goods lines in one line of text: 'ღორღი 0–5 მმ 20 ტონა, ქვიშა 10 ტონა'. */
export const goodsText = (goods: ShipmentItem[] | undefined) => (goods ?? []).map((g) => `${g.name} ${formatNumber(g.quantity, 3)}${g.unitTxt ? ` ${g.unitTxt}` : ''}`).join(', ')
