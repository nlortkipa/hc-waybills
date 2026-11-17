import { useMemo } from 'react'
import { useDb } from '../api/store'
import type { Database, Shipment } from '../types'
import { resolveRoute, routeText } from './route'
import { plateKey } from './rs'

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
      const r = resolveRoute(d.carriers, s.carrierId, s.destinationId)
      const rs = s.rsRemote
      const sent = s.rsWaybill
      const moved = !!rs && !!sent && (rs.startAddress.trim() !== sent.startAddress.trim() || rs.endAddress.trim() !== sent.endAddress.trim())
      return {
        carrier: carriers.get(s.carrierId)?.name ?? '—',
        route: moved ? routeText({ start: rs!.startAddress, end: rs!.endAddress }) : routeText(r),
        driver: rs && sent && rs.driverTin !== sent.driverTin ? rs.driverName || rs.driverTin : this.driverName(s.driverId),
        plate: rs && sent && plateKey(rs.carNumber) !== plateKey(sent.carNumber) ? rs.carNumber || '—' : (trucks.get(s.truckId)?.plateNumber ?? '—'),
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
