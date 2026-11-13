import { ArrowLeft, Copy, FileText, MessageSquare, RotateCw, Scale as ScaleIcon, Weight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { shipments } from '../api'
import { weighingMocked } from '../api/integrations'
import { Badge, Button, Card, EmptyState, Field, Input, JsonBlock, Modal, StatusBadge, StepIcon } from '../components/ui'
import { useToast } from '../components/toast'
import { cx, formatDateTime, formatKg, formatNumber, formatTime, formatTonnes } from '../lib/util'
import { useLookup } from '../lib/lookup'
import { useDb } from '../mock/db'
import { useUser } from '../session'
import type { StepStatus } from '../types'

export function ShipmentDetail() {
  const { id } = useParams()
  const user = useUser()
  const d = useDb()
  const L = useLookup()
  const toast = useToast()
  const s = d.shipments.find((x) => x.id === id)
  const [weighOpen, setWeighOpen] = useState(false)
  const [weight, setWeight] = useState('')
  const [showPayload, setShowPayload] = useState(false)

  if (!s || (user.role === 'operator' && s.carrierId !== user.carrierId)) {
    return <EmptyState icon={<FileText className="size-6" />} title="რეისი ვერ მოიძებნა" action={<Link to="/shipments" className="text-sm font-medium text-brand-600">რეისებზე დაბრუნება</Link>} />
  }

  const x = L.describe(s)
  const driver = L.driver(s.driverId)
  const truck = L.truck(s.truckId)
  const creator = L.user(s.createdBy)
  const canAct = user.role !== 'report'
  const variance = s.scale.weightKg != null ? ((s.scale.weightKg - s.quantity * 1000) / (s.quantity * 1000)) * 100 : null

  const weighStep: StepStatus = s.status === 'weighed' ? 'ok' : s.status === 'at_scale' ? 'running' : 'pending'
  const steps: { title: string; icon: ReactNode; status: StepStatus; detail: ReactNode; action?: ReactNode }[] = [
    {
      title: 'ზედნადების ატვირთვა RS.ge-ზე',
      icon: <FileText className="size-4" />,
      status: s.rs.status,
      detail: s.rs.status === 'ok' ? <>ზედნადები <b className="font-mono">№{s.waybillNumber}</b></> : s.rs.error ?? (s.rs.status === 'running' ? 'იტვირთება…' : 'მოლოდინში'),
      action: canAct && s.status === 'rs_failed' && (
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} onClick={() => void shipments.run(s.id)}>
          ხელახლა ცდა
        </Button>
      ),
    },
    {
      title: 'მძღოლისთვის SMS-ის გაგზავნა',
      icon: <MessageSquare className="size-4" />,
      status: s.sms.status,
      detail: s.sms.status === 'ok' ? `გაეგზავნა ${s.sms.to}` : s.sms.error ?? (s.sms.status === 'running' ? 'იგზავნება…' : s.sms.status === 'skipped' ? 'გამოტოვებულია' : 'მოლოდინში'),
      action: canAct && s.sms.status === 'failed' && (
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} onClick={() => void shipments.retrySms(s.id)}>
          ხელახლა გაგზავნა
        </Button>
      ),
    },
    {
      title: 'სასწორზე გაგზავნა',
      icon: <ScaleIcon className="size-4" />,
      status: s.scale.status,
      detail: s.scale.status === 'ok' ? `გაიგზავნა ${formatTime(s.scale.sentAt)} · docEntry ${s.waybillNumber}` : s.scale.error ?? (s.scale.status === 'running' ? 'იგზავნება…' : s.scale.status === 'skipped' ? 'გამოტოვებულია' : 'მოლოდინში'),
      action: canAct && s.status === 'scale_failed' && (
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} onClick={() => void shipments.run(s.id)}>
          ხელახლა ცდა
        </Button>
      ),
    },
    {
      title: 'მანქანა აიწონა',
      icon: <Weight className="size-4" />,
      status: s.status === 'rs_failed' ? 'skipped' : weighStep,
      detail: s.status === 'weighed' ? <><b>{formatKg(s.scale.weightKg)}</b> · {formatTime(s.scale.weighedAt)}</> : s.status === 'at_scale' ? (!weighingMocked() ? 'ელოდება სასწორს (წონა წაიკითხება სასწორის ბაზიდან)' : d.settings.autoWeigh ? `ელოდება სასწორს (სატესტო სასწორი აწონის ~${d.settings.autoWeighDelaySec} წამში)` : 'ელოდება სასწორს') : 'მოლოდინში',
      action: canAct && s.status === 'at_scale' && weighingMocked() && (
        <Button size="sm" variant="secondary" icon={<Weight className="size-3.5" />} onClick={() => { setWeight(String(Math.round(s.quantity * 1000))); setWeighOpen(true) }}>
          აწონვის სიმულაცია
        </Button>
      ),
    },
  ]

  return (
    <>
      <Link to="/shipments" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> რეისები
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{s.waybillNumber ? `№ ${s.waybillNumber}` : 'ზედნადები მოლოდინშია'}</h1>
            <StatusBadge status={s.status} />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            შექმნა {creator ? `${creator.firstName} ${creator.lastName}` : '—'} · {formatDateTime(s.createdAt)} · {x.carrier}
          </p>
        </div>
        {s.waybillNumber && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() => {
              navigator.clipboard?.writeText(s.waybillNumber!).then(() => toast('success', 'ზედნადების ნომერი დაკოპირდა'), () => {})
            }}
          >
            № კოპირება
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {/* Progress */}
          <Card className="p-5 sm:p-6">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">პროგრესი</h2>
            <ol>
              {steps.map((st, i) => (
                <li key={st.title} className="relative flex gap-4 pb-6 last:pb-0">
                  {i < steps.length - 1 && <span className={cx('absolute top-7 bottom-1 left-[9px] w-0.5 rounded-full', st.status === 'ok' ? 'bg-emerald-200' : 'bg-slate-200')} />}
                  <StepIcon status={st.status} className="relative mt-0.5 bg-surface" />
                  <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                        <span className="text-slate-400">{st.icon}</span>
                        {st.title}
                      </p>
                      <p className={cx('mt-0.5 text-sm', st.status === 'failed' ? 'text-rose-600' : 'text-slate-500')}>{st.detail}</p>
                    </div>
                    {st.action}
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {s.status === 'weighed' && (
            <div className="grid grid-cols-3 gap-3">
              <Metric label={<><span className="sm:hidden">დეკლარ.</span><span className="hidden sm:inline">დეკლარირებული</span></>} value={formatTonnes(s.quantity)} />
              <Metric label="რეალური წონა" value={formatKg(s.scale.weightKg)} strong />
              <Metric label="სხვაობა" value={variance == null ? '—' : `${variance > 0 ? '+' : ''}${formatNumber(variance, 1)}%`} tone={variance != null && Math.abs(variance) > 3 ? 'text-amber-600' : 'text-slate-900'} />
            </div>
          )}

          {/* Timeline */}
          <Card className="p-5 sm:p-6">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">ისტორია</h2>
            <ul className="space-y-3">
              {[...s.events].reverse().map((e, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', e.level === 'success' ? 'bg-emerald-500' : e.level === 'error' ? 'bg-rose-500' : 'bg-slate-300')} />
                  <div className="flex min-w-0 flex-1 flex-wrap justify-between gap-x-4">
                    <span className={e.level === 'error' ? 'text-rose-700' : 'text-slate-700'}>{e.message}</span>
                    <span className="text-xs whitespace-nowrap text-slate-400 tabular-nums">{formatDateTime(e.at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">დეტალები</h2>
            <dl className="divide-y divide-separator text-sm">
              <Info k="კარიერი" v={x.carrier} />
              <Info k="მარშრუტი" v={x.route} />
              <Info k="სასწორის ID" v={x.scaleId} mono />
              <Info k="მძღოლი" v={x.driver} />
              <Info k="პირადი ნომერი" v={driver?.personalId} mono />
              <Info k="ტელეფონი" v={driver?.phone} />
              <Info k="მანქანა" v={truck?.model} />
              <Info k="სახელმწიფო ნომერი" v={truck?.plateNumber} mono />
              <Info k="მისაბმელი" v={truck?.trailerNumber || undefined} mono />
              <Info k="ტვირთი" v={s.cargo.description ? `${s.cargo.description}${s.cargo.code ? ` (${s.cargo.code})` : ''}` : undefined} />
              <Info k="დეკლარირებული" v={formatTonnes(s.quantity)} />
            </dl>
          </Card>

          {s.sms.text && (
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">SMS მძღოლს</h2>
                <Badge tone={s.sms.status === 'ok' ? 'green' : s.sms.status === 'failed' ? 'red' : 'blue'}>{s.sms.status === 'ok' ? 'მიწოდებულია' : s.sms.status === 'failed' ? 'ვერ გაიგზავნა' : 'იგზავნება'}</Badge>
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-3 text-sm text-slate-800">{s.sms.text}</div>
              <p className="mt-2 text-xs text-slate-400">მიმღები: {s.sms.to}</p>
            </Card>
          )}

          {s.scale.payload && (
            <Card className="p-5">
              <button onClick={() => setShowPayload((v) => !v)} className="flex w-full items-center justify-between text-left">
                <h2 className="text-sm font-semibold text-slate-900">სასწორის payload</h2>
                <span className="text-xs font-medium text-brand-600">{showPayload ? 'დამალვა' : 'JSON-ის ნახვა'}</span>
              </button>
              {showPayload && (
                <div className="mt-3">
                  <JsonBlock value={s.scale.payload} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={weighOpen}
        onClose={() => setWeighOpen(false)}
        title="სასწორის პასუხის სიმულაცია"
        footer={
          <>
            <Button variant="secondary" onClick={() => setWeighOpen(false)}>
              გაუქმება
            </Button>
            <Button
              onClick={() => {
                const w = Math.round(Number(weight))
                if (!(w > 0)) return toast('error', 'შეიყვანე დადებითი წონა')
                void shipments.simulateWeighing(s.id, w)
                setWeighOpen(false)
                toast('success', `წონა მიღებულია: ${formatKg(w)}`)
              }}
            >
              წონის გაგზავნა
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-slate-600">
          იმიტაცია: სასწორმა აწონა მანქანა და დააბრუნა <span className="font-mono">docEntry {s.waybillNumber}</span> და წონა.
        </p>
        <Field label="რეალური წონა (კგ)">
          <Input type="number" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </>
  )
}

function Info({ k, v, mono }: { k: string; v?: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-slate-500">{k}</dt>
      <dd className={cx('min-w-0 text-right text-slate-900 [overflow-wrap:anywhere]', mono && 'font-mono text-[13px]')}>{v ?? '—'}</dd>
    </div>
  )
}

function Metric({ label, value, strong, tone = 'text-slate-900' }: { label: ReactNode; value: string; strong?: boolean; tone?: string }) {
  return (
    <Card className={cx('p-4', strong && 'bg-emerald-50/50 ring-emerald-200')}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cx('mt-1 text-base font-semibold tabular-nums sm:text-lg', tone)}>{value}</p>
    </Card>
  )
}
