import { AlertTriangle, CheckCircle2, Clock, FileCheck2, Plus, Truck } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { userCarriers, visibleShipments } from '../api'
import { ShipmentList } from '../components/ShipmentList'
import { Card, EmptyState, LinkButton, PageHeader, Stat } from '../components/ui'
import { useDb } from '../api/store'
import { useUser } from '../session'
import { tbilisiDay } from '../lib/util'

export function Dashboard() {
  const user = useUser()
  const d = useDb()
  const rows = useMemo(() => visibleShipments(d, user), [d, user])
  const mine = user.role === 'operator' ? userCarriers(d, user) : []

  const today = tbilisiDay()
  const todays = rows.filter((s) => tbilisiDay(s.createdAt) === today)
  const waiting = rows.filter((s) => s.status === 'uploading' || s.sms.status === 'running')
  const failed = rows.filter((s) => s.status === 'rs_failed' || s.sms.status === 'failed')
  const uploadedToday = todays.filter((s) => s.status === 'uploaded' && s.waybillState !== 'cancelled')

  return (
    <>
      <PageHeader
        title={`გამარჯობა, ${user.firstName}`}
        subtitle={mine.length ? `${mine.length > 1 ? 'კარიერები' : 'კარიერი'}: ${mine.map((c) => c.name).join(', ')}` : 'ყველა კარიერის მიმოხილვა'}
        actions={
          <span className="hidden sm:block">
            <LinkButton to="/new" icon={<Plus className="size-4" />}>
              ახალი რეისი
            </LinkButton>
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-3 min-[370px]:grid-cols-2 lg:grid-cols-4 lg:gap-4">
        <Stat label="დღეს" value={todays.length} sub="შექმნილი რეისი" icon={<Truck className="size-5" />} />
        <Stat label="მიმდინარე" value={waiting.length} sub="მუშავდება" icon={<Clock className="size-5" />} accent="bg-amber-500" />
        <Stat label="დღეს ატვირთული" value={uploadedToday.length} sub="ზედნადები" icon={<FileCheck2 className="size-5" />} accent="bg-emerald-500" />
        <Stat label="საჭიროებს ყურადღებას" value={failed.length} sub="შეცდომით" icon={failed.length ? <AlertTriangle className="size-5" /> : <CheckCircle2 className="size-5" />} accent={failed.length ? 'bg-rose-500' : 'bg-slate-400'} />
      </div>

      {/* Mobile primary action */}
      <div className="mt-4 sm:hidden">
        <LinkButton to="/new" size="lg" className="w-full" icon={<Plus className="size-5" />}>
          ახალი რეისი
        </LinkButton>
      </div>

      {failed.length > 0 && (
        <Card className="mt-6 overflow-hidden">
          <div className="flex items-center gap-2 hairline-b bg-rose-50 px-5 py-3">
            <AlertTriangle className="size-4 text-rose-500" />
            <h2 className="text-sm font-semibold text-rose-900">საჭიროებს ყურადღებას</h2>
          </div>
          <ShipmentList rows={failed} showCarrier={user.role !== 'operator' || mine.length > 1} />
        </Card>
      )}

      <Card className="mt-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-separator px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">ბოლო რეისები</h2>
          <Link to="/shipments" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            ყველას ნახვა
          </Link>
        </div>
        {rows.length ? (
          <ShipmentList rows={rows.slice(0, 8)} showCarrier={user.role !== 'operator' || mine.length > 1} />
        ) : (
          <EmptyState icon={<Truck className="size-6" />} title="რეისები ჯერ არ არის" text="შექმენი პირველი რეისი ზედნადების ასატვირთად." />
        )}
      </Card>
    </>
  )
}
