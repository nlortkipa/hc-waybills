import type { Carrier, Destination } from '../types'

export interface ResolvedRoute {
  carrier?: Carrier
  destination?: Destination
  start: string
  end: string
  scaleId: string
}

/** Resolves a shipment's start/end addresses and scale ID from its carrier. */
export function resolveRoute(carriers: Carrier[], carrierId: string, destinationId: string): ResolvedRoute {
  const carrier = carriers.find((c) => c.id === carrierId)
  const destination = carrier?.destinations.find((x) => x.id === destinationId)
  return {
    carrier,
    destination,
    start: carrier?.startAddress ?? '',
    end: destination?.address ?? '',
    scaleId: destination?.scaleId ?? '',
  }
}

export const routeText = (r: ResolvedRoute) => (r.start || r.end ? `${r.start || '—'} → ${r.end || '—'}` : '—')
