import type { Carrier, CarrierRoute, Destination, User } from '../types.ts'

export interface ResolvedRoute {
  carrier?: Carrier
  destination?: Destination
  start: string
  end: string
}

/** Resolves start/end addresses: the carrier's start address and one of its end addresses. */
export function resolveRoute(carriers: Carrier[], carrierId: string, destinationId: string): ResolvedRoute {
  const carrier = carriers.find((c) => c.id === carrierId)
  const destination = carrier?.destinations.find((x) => x.id === destinationId)
  return {
    carrier,
    destination,
    start: carrier?.startAddress ?? '',
    end: destination?.address ?? '',
  }
}

export const routeText = (r: { start: string; end: string }) => (r.start || r.end ? `${r.start || '—'} → ${r.end || '—'}` : '—')

/** 'Start → End' of a route, as shown in pickers and lists. */
export const routeLabel = (carriers: Carrier[], r: Pick<CarrierRoute, 'carrierId' | 'destinationId'>) => routeText(resolveRoute(carriers, r.carrierId, r.destinationId))

/** A route that can be picked for a new shipment: it, its carrier and its end address all still exist. */
export function routeUsable(carriers: Carrier[], r: CarrierRoute): boolean {
  const x = resolveRoute(carriers, r.carrierId, r.destinationId)
  return !r.deletedAt && !!x.carrier && !x.carrier.deletedAt && !!x.destination && !x.destination.deletedAt
}

/** Whether a user may see and create shipments of a carrier: operators only their own carriers. */
export const canUseCarrier = (user: User, carrierId: string) => user.role !== 'operator' || (user.carrierIds ?? []).includes(carrierId)
