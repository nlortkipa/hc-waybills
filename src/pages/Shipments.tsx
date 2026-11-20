import { Download, Plus, Search, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { userCarriers, visibleShipments } from '../api'
import { ShipmentList } from '../components/ShipmentList'
import { DateRange } from '../components/DateRange'
import { Button, Card, EmptyState, Input, LinkButton, PageHeader, Select, shipmentState } from '../components/ui'
import { useToast } from '../components/toast'
import { exportShipments } from '../lib/exportShipments'
import { cx, shiftMonths, tbilisiDay } from '../lib/util'
import { useLookup } from '../lib/lookup'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { ShipmentStatus } from '../types'

const filters: { key: 'all' | 'active' | 'failed' | ShipmentStatus; label: string }[] = [
  { key: 'all', label: 'ყველა სტატუსი' },
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
  // Days (Georgian time) the shipment was made, both included: by default this day last month to today.
  const [from, setFrom] = useState(() => shiftMonths(tbilisiDay(), -1))
  const [to, setTo] = useState(tbilisiDay)
  const all = useMemo(() => visibleShipments(d, user), [d, user])
  const carriers = userCarriers(d, user)
  // Operators with a single carrier don't need the carrier filter or column.
  const multi = user.role !== 'operator' || carriers.length > 1

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((s) => {
      if (carrier && s.carrierId !== carrier) return false
      const day = tbilisiDay(s.createdAt)
      if (day < from || day > to) return false
      if (f === 'active' && s.status !== 'uploading' && s.sms.status !== 'running') return false
      if (f === 'failed' && s.status !== 'rs_failed' && s.sms.status !== 'failed') return false
      if (f !== 'all' && f !== 'active' && f !== 'failed' && s.status !== f) return false
      if (!needle) return true
      const x = L.describe(s)
      return [s.waybillNumber, x.carrier, x.route, x.driver, x.plate, shipmentState(s).label, x.item].some((v) => v?.toLowerCase().includes(needle))
    })
  }, [all, q, f, carrier, from, to, L])

  const canCreate = user.role !== 'report'
  const toast = useToast()
  const exportXlsx = async () => {
    const err = await exportShipments(`hc-reisebi-${from}_${to}.xlsx`, rows, L)
    if (err) toast('error', err)
  }

  return (
    <>
      <PageHeader
        title="რეისები"
        subtitle={`სულ ${all.length}${user.role === 'operator' && carriers.length === 1 ? ` · ${carriers[0].name}` : ''}`}
        actions={
          <>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => void exportXlsx()} disabled={!rows.length}>
              Excel
            </Button>
            {canCreate && (
              <span className="hidden sm:block">
                <LinkButton to="/new" icon={<Plus className="size-4" />}>
                  ახალი რეისი
                </LinkButton>
              </span>
            )}
          </>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className={cx('grid w-full gap-2 sm:flex sm:w-auto sm:shrink-0', multi && 'grid-cols-2')}>
              <Select aria-label="სტატუსი" value={f} onChange={(e) => setF(e.target.value as typeof f)} className="sm:w-44">
                {filters.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
              </Select>
              {multi && (
                <Select aria-label="კარიერი" value={carrier} onChange={(e) => setCarrier(e.target.value)} className="sm:w-48">
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
            <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
            <div className="relative w-full min-w-56 sm:w-auto sm:flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ზედნადები, მძღოლი, მანქანა, მარშრუტი…" className="pl-9" />
            </div>
          </div>
          <p className="text-xs text-slate-500">{rows.length} რეისი</p>
        </div>
        {rows.length ? (
          <ShipmentList rows={rows} showCarrier={multi} />
        ) : (
          <EmptyState icon={<Truck className="size-6" />} title="რეისები ვერ მოიძებნა" text="სცადე სხვა პერიოდი, ძებნა ან ფილტრი." />
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
