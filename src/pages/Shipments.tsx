import { Plus, Search, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { userCarriers, visibleShipments } from '../api'
import { ShipmentList } from '../components/ShipmentList'
import { Card, EmptyState, Input, LinkButton, PageHeader, Select, shipmentState } from '../components/ui'
import { cx } from '../lib/util'
import { useLookup } from '../lib/lookup'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { ShipmentStatus } from '../types'

const filters: { key: 'all' | 'active' | 'failed' | ShipmentStatus; label: string }[] = [
  { key: 'all', label: 'ყველა' },
  { key: 'active', label: 'მიმდინარე' },
  { key: 'saved', label: 'შენახული' },
  { key: 'uploaded', label: 'ატვირთული' },
  { key: 'failed', label: 'შეცდომით' },
]

export function Shipments() {
  const user = useUser()
  const d = useDb()
  const L = useLookup()
  const [q, setQ] = useState('')
  const [f, setF] = useState<(typeof filters)[number]['key']>('all')
  const [carrier, setCarrier] = useState('')
  const all = useMemo(() => visibleShipments(d, user), [d, user])
  const carriers = userCarriers(d, user)
  // Operators with a single carrier don't need the carrier filter or column.
  const multi = user.role !== 'operator' || carriers.length > 1

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((s) => {
      if (carrier && s.carrierId !== carrier) return false
      if (f === 'active' && s.status !== 'uploading' && s.sms.status !== 'running') return false
      if (f === 'failed' && s.status !== 'rs_failed' && s.sms.status !== 'failed') return false
      if (f !== 'all' && f !== 'active' && f !== 'failed' && s.status !== f) return false
      if (!needle) return true
      const x = L.describe(s)
      return [s.waybillNumber, x.carrier, x.route, x.driver, x.plate, shipmentState(s).label, x.item].some((v) => v?.toLowerCase().includes(needle))
    })
  }, [all, q, f, carrier, L])

  const canCreate = user.role !== 'report'

  return (
    <>
      <PageHeader
        title="რეისები"
        subtitle={`სულ ${all.length}${user.role === 'operator' && carriers.length === 1 ? ` · ${carriers[0].name}` : ''}`}
        actions={
          canCreate && (
            <span className="hidden sm:block">
              <LinkButton to="/new" icon={<Plus className="size-4" />}>
                ახალი რეისი
              </LinkButton>
            </span>
          )
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ძებნა: ზედნადები, მძღოლი, ნომერი, მარშრუტი…" className="pl-9" />
        </div>
        {multi && (
          <Select value={carrier} onChange={(e) => setCarrier(e.target.value)} className="sm:w-56">
            <option value="">ყველა კარიერი</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.deletedAt ? ' (წაშლილი)' : ''}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {filters.map((x) => (
          <button
            key={x.key}
            onClick={() => setF(x.key)}
            className={cx(
              'pressable h-8 shrink-0 rounded-full px-3.5 text-[13px] transition-colors',
              f === x.key ? 'bg-brand-600 font-semibold text-white' : 'bg-surface text-slate-900 hover:bg-fill',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {rows.length ? (
          <ShipmentList rows={rows} showCarrier={multi} />
        ) : (
          <EmptyState icon={<Truck className="size-6" />} title="რეისები ვერ მოიძებნა" text="სცადე სხვა ძებნა ან ფილტრი." />
        )}
      </Card>

      {canCreate && (
        <Link to="/new" className="pressable fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-20 grid size-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg shadow-black/20 sm:hidden" aria-label="ახალი რეისი">
          <Plus className="size-6" />
        </Link>
      )}
    </>
  )
}
