import { ChevronRight, MapPin, Truck as TruckIcon, User as UserIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { formatDateTime, formatKg, formatTonnes } from '../lib/util'
import { useLookup } from '../lib/lookup'
import type { Shipment } from '../types'
import { StatusBadge } from './ui'

export function ShipmentList({ rows, showCarrier }: { rows: Shipment[]; showCarrier?: boolean }) {
  const L = useLookup()
  const nav = useNavigate()
  const open = (id: string) => nav(`/shipments/${id}`)

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-separator text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3">ზედნადები</th>
              <th className="px-3 py-3">შექმნილია</th>
              {showCarrier && <th className="px-3 py-3">კარიერი</th>}
              <th className="px-3 py-3">მარშრუტი</th>
              <th className="px-3 py-3">მძღოლი / მანქანა</th>
              <th className="px-3 py-3 text-right">დეკლარ.</th>
              <th className="px-3 py-3 text-right">აწონილი</th>
              <th className="px-3 py-3">სტატუსი</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-separator">
            {rows.map((s) => {
              const x = L.describe(s)
              return (
                <tr key={s.id} onClick={() => open(s.id)} className="cursor-pointer transition-colors hover:bg-slate-50/80">
                  <td className="px-5 py-3 font-mono text-[13px] font-medium text-slate-900">{s.waybillNumber ?? <span className="font-sans text-slate-400">—</span>}</td>
                  <td className="px-3 py-3 whitespace-nowrap text-slate-600">{formatDateTime(s.createdAt)}</td>
                  {showCarrier && <td className="px-3 py-3 text-slate-700">{x.carrier}</td>}
                  <td className="px-3 py-3">
                    <p className="text-slate-800">{x.route}</p>
                    <p className="text-xs text-slate-400">{x.scaleId}</p>
                  </td>
                  <td className="px-3 py-3">
                    <p className="text-slate-800">{x.driver}</p>
                    <p className="font-mono text-xs text-slate-400">{x.plate}</p>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums text-slate-700">{formatTonnes(s.quantity)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums font-medium text-slate-900">{formatKg(s.scale.weightKg)}</td>
                  <td className="px-3 py-3">
                    <StatusBadge status={s.status} />
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
      <ul className="divide-y divide-separator md:hidden">
        {rows.map((s) => {
          const x = L.describe(s)
          return (
            <li key={s.id}>
              <button onClick={() => open(s.id)} className="w-full px-4 py-3.5 text-left active:bg-slate-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-slate-900">{s.waybillNumber ?? 'ზედნადები ჯერ არ არის'}</p>
                    <p className="text-xs text-slate-500">
                      {formatDateTime(s.createdAt)}
                      {showCarrier && ` · ${x.carrier}`}
                    </p>
                  </div>
                  <StatusBadge status={s.status} />
                </div>
                <div className="mt-2.5 space-y-1 text-[13px] text-slate-600">
                  <p className="flex items-center gap-2">
                    <MapPin className="size-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{x.route}</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <UserIcon className="size-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{x.driver}</span>
                    <TruckIcon className="ml-1 size-3.5 shrink-0 text-slate-400" />
                    <span className="font-mono text-xs">{x.plate}</span>
                  </p>
                </div>
                <div className="mt-2.5 flex gap-4 text-xs">
                  <span className="text-slate-500">
                    დეკლარ. <b className="font-medium text-slate-800 tabular-nums">{formatTonnes(s.quantity)}</b>
                  </span>
                  <span className="text-slate-500">
                    აწონილი <b className="font-medium text-slate-800 tabular-nums">{formatKg(s.scale.weightKg)}</b>
                  </span>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
