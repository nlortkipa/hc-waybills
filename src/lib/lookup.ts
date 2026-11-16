import { useMemo } from 'react'
import { useDb } from '../mock/db'
import type { Database, Shipment } from '../types'
import { resolveRoute, routeText } from './route'

export function makeLookup(d: Database) {
  const by = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]))
  const carriers = by(d.carriers)
  const drivers = by(d.drivers)
  const trucks = by(d.trucks)
  const users = by(d.users)
  return {
    carrier: (id: string) => carriers.get(id),
    driver: (id: string) => drivers.get(id),
    truck: (id: string) => trucks.get(id),
    user: (id: string) => users.get(id),
    driverName: (id: string) => {
      const x = drivers.get(id)
      return x ? `${x.firstName} ${x.lastName}` : '—'
    },
    describe(s: Shipment) {
      const r = resolveRoute(d.carriers, s.carrierId, s.destinationId)
      return {
        carrier: carriers.get(s.carrierId)?.name ?? '—',
        route: routeText(r),
        driver: this.driverName(s.driverId),
        plate: trucks.get(s.truckId)?.plateNumber ?? '—',
        item: s.cargo.description || '—',
      }
    },
  }
}

export type Lookup = ReturnType<typeof makeLookup>

export function useLookup(): Lookup {
  const d = useDb()
  return useMemo(() => makeLookup(d), [d])
}
