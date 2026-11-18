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
    /** Display values of a shipment. Where its waybill was corrected on RS.ge, RS.ge's values are shown. */
    describe(s: Shipment) {
      const r = resolveRoute(d, s.routeId)
      const rs = s.rsRemote
      const sent = s.rsWaybill
      const moved = !!rs && !!sent && (rs.startAddress.trim() !== sent.startAddress.trim() || rs.endAddress.trim() !== sent.endAddress.trim())
      return {
        carrier: carriers.get(s.carrierId)?.name ?? '—',
        // As RS.ge has it, else as sent (without transport the end is the start), else the route.
        route: moved ? routeText({ start: rs!.startAddress, end: rs!.endAddress }) : sent ? routeText({ start: sent.startAddress, end: sent.endAddress }) : routeText(r),
        driver: rs && sent && rs.driverTin !== sent.driverTin ? rs.driverName || rs.driverTin : this.driverName(s.driverId),
        plate: rs && sent && plateKey(rs.carNumber) !== plateKey(sent.carNumber) ? rs.carNumber || '—' : (trucks.get(s.truckId)?.plateNumber ?? '—'),
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
