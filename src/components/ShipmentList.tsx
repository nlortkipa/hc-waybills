import { ChevronRight, MapPin, Truck as TruckIcon, User as UserIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { rsPending, useRsLoad } from '../api'
import { shipmentQuantity } from '../lib/rs'
import { formatDateTime, formatTonnes } from '../lib/util'
import { useLookup } from '../lib/lookup'
import type { Shipment } from '../types'
import { ShipmentBadge } from './ui'

export function ShipmentList({ rows, showCarrier }: { rows: Shipment[]; showCarrier?: boolean }) {
  const L = useLookup()
  const nav = useNavigate()
  const open = (id: string) => nav(`/shipments/${id}`)
  // Quantities and states are RS.ge's: ask for the listed waybills that aren't read yet.
  useRsLoad(rows)
  /** The quantity as RS.ge has it; '…' while it is being read. */
  const qty = (s: Shipment) => (rsPending(s) ? '…' : formatTonnes(shipmentQuantity(s)))

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto xl:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-separator text-left text-xs text-slate-500 [&>th]:font-medium">
              <th className="px-5 py-3">ზედნადები</th>
              <th className="px-3 py-3">მარშრუტი</th>
              <th className="px-3 py-3">მძღოლი / მანქანა</th>
              <th className="px-3 py-3 text-right">დეკლარირებული</th>
              <th className="px-3 py-3">სტატუსი</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-separator">
            {rows.map((s) => {
              const x = L.describe(s)
              return (
                <tr key={s.id} onClick={() => open(s.id)} className="cursor-pointer transition-colors hover:bg-slate-50/80">
                  <td className="px-5 py-3 whitespace-nowrap">
                    <p className="font-mono text-[13px] font-medium text-slate-900">{s.waybillNumber ?? <span className="font-sans text-slate-400">—</span>}</p>
                    <p className="text-xs text-slate-500">{formatDateTime(s.createdAt)}</p>
                  </td>
                  <td className="min-w-40 px-3 py-3">
                    <p className="text-slate-800">{x.route}</p>
                    {showCarrier && <p className="text-xs text-slate-500">{x.carrier}</p>}
                  </td>
                  <td className="min-w-40 px-3 py-3">
                    <p className="text-slate-800">{x.driver}</p>
                    <p className="font-mono text-xs text-slate-400">{x.plate}</p>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums text-slate-700">{qty(s)}</td>
                  <td className="px-3 py-3">
                    <ShipmentBadge s={s} />
                  </td>
                  <td className="pr-4">
                    <ChevronRight className="size-4 text-slate-300" />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <ul className="divide-y divide-separator xl:hidden">
        {rows.map((s) => {
          const x = L.describe(s)
          return (
            <li key={s.id}>
              <button onClick={() => open(s.id)} className="w-full px-4 py-3.5 text-left active:bg-slate-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {s.waybillNumber ? <p className="font-mono text-sm font-semibold text-slate-900">{s.waybillNumber}</p> : <p className="text-sm font-semibold text-slate-500">ნომრის გარეშე</p>}
                    <p className="text-xs text-slate-500">
                      {formatDateTime(s.createdAt)}
                      {showCarrier && ` · ${x.carrier}`}
                    </p>
                  </div>
                  <ShipmentBadge s={s} />
                </div>
                <div className="mt-2.5 space-y-1 text-[13px] text-slate-600">
                  <p className="flex items-center gap-2">
                    <MapPin className="size-3.5 shrink-0 text-slate-400" />
                    <span className="min-w-0 truncate">{x.route}</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <UserIcon className="size-3.5 shrink-0 text-slate-400" />
                    <span className="min-w-0 truncate">{x.driver}</span>
                    <TruckIcon className="ml-1 size-3.5 shrink-0 text-slate-400" />
                    <span className="shrink-0 font-mono text-xs">{x.plate}</span>
                  </p>
                </div>
                <p className="mt-2.5 text-xs text-slate-500">
                  დეკლარირებული <b className="font-medium text-slate-800 tabular-nums">{qty(s)}</b>
                </p>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
