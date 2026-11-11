import { useMemo } from 'react'
import { useDb } from '../mock/db'
import type { Database, Shipment } from '../types'

export function makeLookup(d: Database) {
  const by = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]))
  const carriers = by(d.carriers)
  const routes = by(d.routes)
  const drivers = by(d.drivers)
  const trucks = by(d.trucks)
  const items = by(d.items)
  const users = by(d.users)
  return {
    carrier: (id: string) => carriers.get(id),
    route: (id: string) => routes.get(id),
    driver: (id: string) => drivers.get(id),
    truck: (id: string) => trucks.get(id),
    item: (id: string) => items.get(id),
    user: (id: string) => users.get(id),
    driverName: (id: string) => {
      const x = drivers.get(id)
      return x ? `${x.firstName} ${x.lastName}` : '—'
    },
    routeLabel: (id: string) => {
      const r = routes.get(id)
      return r ? `${r.startLocation} → ${r.endLocation}` : '—'
    },
    describe(s: Shipment) {
      return {
        carrier: carriers.get(s.carrierId)?.name ?? '—',
        route: this.routeLabel(s.routeId),
        scaleId: routes.get(s.routeId)?.name ?? '—',
        driver: this.driverName(s.driverId),
        plate: trucks.get(s.truckId)?.plateNumber ?? '—',
        item: items.get(s.itemId)?.description ?? '—',
      }
    },
  }
}

export type Lookup = ReturnType<typeof makeLookup>

export function useLookup(): Lookup {
  const d = useDb()
  return useMemo(() => makeLookup(d), [d])
}
