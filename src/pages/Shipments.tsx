import { Plus, Search, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { visibleShipments } from '../api'
import { ShipmentList } from '../components/ShipmentList'
import { Button, Card, EmptyState, Input, PageHeader, Select, statusMeta } from '../components/ui'
import { cx } from '../lib/util'
import { useLookup } from '../lib/lookup'
import { useDb } from '../mock/db'
import { useUser } from '../session'
import type { ShipmentStatus } from '../types'

const filters: { key: 'all' | 'active' | 'failed' | ShipmentStatus; label: string }[] = [
  { key: 'all', label: 'ყველა' },
  { key: 'active', label: 'მიმდინარე' },
  { key: 'weighed', label: 'აწონილი' },
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

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((s) => {
      if (carrier && s.carrierId !== carrier) return false
      if (f === 'active' && !['uploading', 'uploaded', 'at_scale'].includes(s.status)) return false
      if (f === 'failed' && !['rs_failed', 'scale_failed'].includes(s.status) && s.sms.status !== 'failed') return false
      if (f !== 'all' && f !== 'active' && f !== 'failed' && s.status !== f) return false
      if (!needle) return true
      const x = L.describe(s)
      return [s.waybillNumber, x.carrier, x.route, x.driver, x.plate, x.scaleId, statusMeta[s.status].label].some((v) => v?.toLowerCase().includes(needle))
    })
  }, [all, q, f, carrier, L])

  const canCreate = user.role !== 'report'

  return (
    <>
      <PageHeader
        title="რეისები"
        subtitle={`სულ ${all.length}${user.role === 'operator' ? ` · ${L.carrier(user.carrierId!)?.name}` : ''}`}
        actions={
          canCreate && (
            <Link to="/new" className="hidden sm:block">
              <Button icon={<Plus className="size-4" />}>ახალი რეისი</Button>
            </Link>
          )
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ძებნა: ზედნადები, მძღოლი, ნომერი, მარშრუტი…" className="pl-9" />
        </div>
        {user.role !== 'operator' && (
          <Select value={carrier} onChange={(e) => setCarrier(e.target.value)} className="sm:w-56">
            <option value="">ყველა კარიერი</option>
            {d.carriers.map((c) => (
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
              'pressable h-8 shrink-0 rounded-full px-3.5 text-[15px] transition-colors',
              f === x.key ? 'bg-brand-600 font-semibold text-white' : 'bg-surface text-slate-900 hover:bg-fill',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {rows.length ? (
          <ShipmentList rows={rows} showCarrier={user.role !== 'operator'} />
        ) : (
          <EmptyState icon={<Truck className="size-6" />} title="რეისები ვერ მოიძებნა" text="სცადე სხვა ძებნა ან ფილტრი." />
        )}
      </Card>

      {canCreate && (
        <Link to="/new" className="fixed right-4 bottom-24 z-20 sm:hidden" aria-label="ახალი რეისი">
          <span className="grid size-14 place-items-center pressable rounded-full bg-brand-600 text-white shadow-lg shadow-black/20">
            <Plus className="size-6" />
          </span>
        </Link>
      )}
    </>
  )
}
