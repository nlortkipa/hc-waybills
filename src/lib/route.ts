import type { Carrier, CarrierRoute, User } from '../types.ts'

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

/** A route that can be picked for a new shipment: it and its carrier still exist. */
export function routeUsable(carriers: Carrier[], r: CarrierRoute): boolean {
  const c = carriers.find((x) => x.id === r.carrierId)
  return !r.deletedAt && !!c && !c.deletedAt && !!r.endAddress.trim()
}

/** Whether a user may see and create shipments of a carrier: operators only their own carriers. */
export const canUseCarrier = (user: User, carrierId: string) => user.role !== 'operator' || (user.carrierIds ?? []).includes(carrierId)
