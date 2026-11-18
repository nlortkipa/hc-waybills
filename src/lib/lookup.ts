import { useMemo } from 'react'
import { useDb } from '../api/store'
import type { Database, Shipment } from '../types'
import { resolveRoute, routeText } from './route'
import { plateKey } from './rs'

/** The shipment's products, e.g. "ღორღი, ქვიშა". */
export const itemsText = (s: Shipment) => s.items.map((i) => i.name).filter(Boolean).join(', ') || '—'

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
    /**
     * Display values of a shipment. Once its waybill is on RS.ge, RS.ge's values are shown (a correction
     * on the rs.ge portal included); ours where they are the same, since RS.ge spells plates its own way.
     */
    describe(s: Shipment) {
      const r = resolveRoute(d, s.routeId)
      const rs = s.rsRemote
      const sent = s.rsWaybill
      const driver = drivers.get(s.driverId)
      const plate = trucks.get(s.truckId)?.plateNumber
      return {
        carrier: carriers.get(s.carrierId)?.name ?? '—',
        // As RS.ge has it, else as sent (without transport the end is the start), else the route.
        route: rs ? routeText({ start: rs.startAddress, end: rs.endAddress }) : sent ? routeText({ start: sent.startAddress, end: sent.endAddress }) : routeText(r),
        driver: rs && rs.driverTin !== (driver?.personalId.trim() ?? '') ? rs.driverName || rs.driverTin || '—' : this.driverName(s.driverId),
        plate: rs && plateKey(rs.carNumber) !== plateKey(plate ?? '') ? rs.carNumber || '—' : (plate ?? '—'),
        item: itemsText(s),
      }
    },
  }
}

export type Lookup = ReturnType<typeof makeLookup>

export function useLookup(): Lookup {
  const d = useDb()
  return useMemo(() => makeLookup(d), [d])
}
