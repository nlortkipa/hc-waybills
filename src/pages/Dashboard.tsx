import { AlertTriangle, CheckCircle2, Clock, Plus, Scale, Truck } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { visibleShipments } from '../api'
import { ShipmentList } from '../components/ShipmentList'
import { Button, Card, EmptyState, PageHeader, Stat } from '../components/ui'
import { formatKg } from '../lib/util'
import { useDb } from '../mock/db'
import { useUser } from '../session'

export function Dashboard() {
  const user = useUser()
  const d = useDb()
  const rows = useMemo(() => visibleShipments(d, user), [d, user])
  const carrier = d.carriers.find((c) => c.id === user.carrierId)

  const today = new Date().toDateString()
  const todays = rows.filter((s) => new Date(s.createdAt).toDateString() === today)
  const waiting = rows.filter((s) => s.status === 'at_scale' || s.status === 'uploading' || s.status === 'uploaded')
  const failed = rows.filter((s) => s.status === 'rs_failed' || s.status === 'scale_failed' || s.sms.status === 'failed')
  const weighedToday = todays.reduce((a, s) => a + (s.scale.weightKg ?? 0), 0)

  return (
    <>
      <PageHeader
        title={`გამარჯობა, ${user.firstName}`}
        subtitle={carrier ? `კარიერი: ${carrier.name}` : 'ყველა კარიერის მიმოხილვა'}
        actions={
          <Link to="/new" className="hidden sm:block">
            <Button icon={<Plus className="size-4" />}>ახალი რეისი</Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Stat label="დღეს" value={todays.length} sub="შექმნილი რეისი" icon={<Truck className="size-5" />} />
        <Stat label="მიმდინარე" value={waiting.length} sub="ელოდება სასწორს" icon={<Clock className="size-5" />} accent="bg-amber-500" />
        <Stat label="დღეს აიწონა" value={formatKg(weighedToday)} sub={`${todays.filter((s) => s.status === 'weighed').length} მანქანა`} icon={<Scale className="size-5" />} accent="bg-emerald-500" />
        <Stat label="საჭიროებს ყურადღებას" value={failed.length} sub="შეცდომით" icon={failed.length ? <AlertTriangle className="size-5" /> : <CheckCircle2 className="size-5" />} accent={failed.length ? 'bg-rose-500' : 'bg-slate-400'} />
      </div>

      {/* Mobile primary action */}
      <Link to="/new" className="mt-4 block sm:hidden">
        <Button size="lg" className="w-full" icon={<Plus className="size-5" />}>
          ახალი რეისი
        </Button>
      </Link>

      {failed.length > 0 && (
        <Card className="mt-6 overflow-hidden">
          <div className="flex items-center gap-2 hairline-b bg-rose-50 px-5 py-3">
            <AlertTriangle className="size-4 text-rose-500" />
            <h2 className="text-sm font-semibold text-rose-900">საჭიროებს ყურადღებას</h2>
          </div>
          <ShipmentList rows={failed} showCarrier={user.role !== 'operator'} />
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
          <ShipmentList rows={rows.slice(0, 8)} showCarrier={user.role !== 'operator'} />
        ) : (
          <EmptyState icon={<Truck className="size-6" />} title="რეისები ჯერ არ არის" text="შექმენი პირველი რეისი ზედნადების ასატვირთად." />
        )}
      </Card>
    </>
  )
}
