import { ArrowDownLeft, ArrowUpRight, ChevronDown, Waypoints } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { logs as logsApi } from '../api'
import { Badge, Card, ConfirmModal, DeleteButton, EmptyState, JsonBlock, PageHeader, Segmented } from '../components/ui'
import { useToast } from '../components/toast'
import { canUseCarrier } from '../lib/route'
import { cx, formatTime } from '../lib/util'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { ServiceName } from '../types'

const serviceTone: Record<ServiceName, 'blue' | 'violet'> = { 'RS.ge': 'blue', SMS: 'violet' }
const serviceLabel: Record<ServiceName, string> = { 'RS.ge': 'RS.ge', SMS: 'SMS' }
/** Who asked for an RS.ge read-back: the background sync, or someone opening a shipment. */
const readBackLabel = { sync: 'სინქრონიზაცია', page: 'რეისის გახსნა' } as const

export function ApiLog() {
  const d = useDb()
  const user = useUser()
  const toast = useToast()
  const [svc, setSvc] = useState<ServiceName | ''>('')
  const [open, setOpen] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const visibleIds = useMemo(() => {
    if (user.role !== 'operator') return null
    return new Set(d.shipments.filter((x) => canUseCarrier(user, x.carrierId)).map((x) => x.id))
  }, [d.shipments, user])
  const logs = d.logs.filter((l) => (!svc || l.service === svc) && (!visibleIds || !l.shipmentId || visibleIds.has(l.shipmentId)))

  return (
    <>
      <PageHeader title="API მოთხოვნები" />

      <Card className="min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-separator px-5 py-3">
          <Segmented value={svc} onChange={setSvc} options={(['', 'RS.ge', 'SMS'] as const).map((x) => ({ value: x, label: x ? serviceLabel[x] : 'ყველა' }))} />
          {user.role === 'admin' && d.logs.length > 0 && (
            <DeleteButton onClick={() => setConfirmClear(true)}>
              <span className="hidden sm:inline">გასუფთავება</span>
            </DeleteButton>
          )}
        </div>
        {logs.length === 0 ? (
          <EmptyState icon={<Waypoints className="size-6" />} title="მოთხოვნები ჯერ არ არის" text="RS.ge-სა და SMS-ის ყველა მოთხოვნა აქ გამოჩნდება." />
        ) : (
          <ul className="divide-y divide-separator">
            {logs.map((l) => {
              const isOpen = open === l.id
              return (
                <li key={l.id}>
                  <button onClick={() => setOpen(isOpen ? null : l.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5">
                    <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg', l.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600')}>
                      {l.direction === 'out' ? <ArrowUpRight className="size-4" /> : <ArrowDownLeft className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge tone={serviceTone[l.service]}>{serviceLabel[l.service]}</Badge>
                        {l.readBack && <Badge tone="gray">{readBackLabel[l.readBack]}</Badge>}
                        {!l.ok && <Badge tone="red">შეცდომა</Badge>}
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-slate-600">{l.endpoint}</p>
                    </div>
                    <div className="shrink-0 text-right text-xs text-slate-400 tabular-nums">
                      <p>{formatTime(l.at)}</p>
                      {l.direction === 'out' && <p>{l.durationMs} მწმ</p>}
                    </div>
                    <ChevronDown className={cx('size-4 shrink-0 text-slate-300 transition-transform', isOpen && 'rotate-180')} />
                  </button>
                  {isOpen && (
                    <div className="grid grid-cols-1 gap-3 bg-slate-50/70 px-4 pb-4 sm:px-5 xl:grid-cols-2">
                      <div className="min-w-0">
                        <p className="mb-1.5 text-xs font-medium text-slate-500">მოთხოვნა</p>
                        <JsonBlock value={l.request} />
                      </div>
                      <div className="min-w-0">
                        <p className="mb-1.5 text-xs font-medium text-slate-500">პასუხი</p>
                        <JsonBlock value={l.response} />
                      </div>
                      {l.shipmentId && (
                        <Link to={`/shipments/${l.shipmentId}`} className="text-xs font-medium text-brand-600 hover:text-brand-700">
                          რეისის გახსნა →
                        </Link>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <ConfirmModal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="გასუფთავდეს ლოგი?"
        confirmLabel="გასუფთავება"
        onConfirm={() => {
          setConfirmClear(false)
          logsApi.clear().catch((e: Error) => toast('error', e.message))
        }}
      />
    </>
  )
}
