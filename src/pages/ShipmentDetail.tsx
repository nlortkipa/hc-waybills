import { ArrowLeft, Ban, CheckCheck, Copy, FileText, MessageSquare, RefreshCw, RotateCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { shipments } from '../api'
import { Badge, Button, Card, ConfirmModal, EmptyState, StatusBadge, StepIcon } from '../components/ui'
import { useToast } from '../components/toast'
import { canUseCarrier } from '../lib/route'
import { cx, formatDateTime, formatNumber } from '../lib/util'
import { useLookup } from '../lib/lookup'
import { plateKey, RS_STATUS } from '../lib/rs'
import { SMS_DELIVERY, SMS_FINAL } from '../lib/sms'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { StepStatus } from '../types'

export function ShipmentDetail() {
  const { id } = useParams()
  const user = useUser()
  const d = useDb()
  const L = useLookup()
  const toast = useToast()
  const s = d.shipments.find((x) => x.id === id)
  const [confirm, setConfirm] = useState<'close' | 'cancel' | null>(null)
  const [busy, setBusy] = useState(false)
  const [rsReading, setRsReading] = useState(false)
  const [rsError, setRsError] = useState('')

  // Opening an uploaded shipment reads its waybill from RS.ge, so changes made on the rs.ge portal show here.
  const readable = !!s && s.status === 'uploaded' && !!s.rsWaybillId
  useEffect(() => {
    if (!readable || !id) return
    let current = true
    shipments.refreshFromRs(id).then(
      () => current && setRsError(''),
      (e: Error) => current && setRsError(e.message),
    )
    return () => {
      current = false
    }
  }, [readable, id])
  // …and asks smsoffice.ge whether the driver got the SMS, until the answer is final.
  const smsOpen = !!s && s.sms.status === 'ok' && !!s.sms.reference && !(s.sms.delivery && SMS_FINAL.includes(s.sms.delivery))
  const smsRef = s?.sms.reference
  useEffect(() => {
    if (smsOpen && id) shipments.refreshSms(id).catch(() => {})
  }, [smsOpen, smsRef, id])

  const readRs = async () => {
    setRsReading(true)
    try {
      await shipments.refreshFromRs(s!.id)
      setRsError('')
    } catch (e) {
      setRsError((e as Error).message)
    } finally {
      setRsReading(false)
    }
  }

  if (!s || !canUseCarrier(user, s.carrierId)) {
    return <EmptyState icon={<FileText className="size-6" />} title="რეისი ვერ მოიძებნა" action={<Link to="/shipments" className="text-sm font-medium text-brand-600">რეისებზე დაბრუნება</Link>} />
  }

  const x = L.describe(s)
  const driver = L.driver(s.driverId)
  const truck = L.truck(s.truckId)
  const creator = L.user(s.createdBy)
  const canAct = user.role !== 'report'
  const onRs = canAct && s.status === 'uploaded' && !!s.rsWaybillId
  const canClose = onRs && !s.waybillState
  // RS.ge also cancels a completed waybill.
  const canCancel = onRs && s.waybillState !== 'cancelled'
  const w = s.rsWaybill
  const good = w?.goods[0]
  const sentAmount = w ? w.goods.reduce((a, g) => a + g.amount, 0) : 0
  const r = s.rsRemote
  const rGood = r?.goods[0]
  // The quantity's unit, when every goods line has the same one.
  const rUnit = r && new Set(r.goods.map((g) => g.unitTxt)).size === 1 ? rGood?.unitTxt : undefined
  const qtyText = (n: number, unit?: string) => `${formatNumber(n, 3)}${unit ? ` ${unit}` : ''}`
  const rStatus = r && (RS_STATUS[r.status] ?? { label: String(r.status), tone: 'gray' as const })
  // 'ok' only means smsoffice.ge accepted it; delivery says whether the phone got it.
  const smsLost = s.sms.status === 'ok' && (s.sms.delivery === 'Undelivered' || s.sms.delivery === 'Expired')
  const smsBadge =
    s.sms.status === 'failed'
      ? { label: 'ვერ გაიგზავნა', tone: 'red' as const }
      : s.sms.status === 'ok'
        ? s.sms.delivery
          ? SMS_DELIVERY[s.sms.delivery]
          : { label: 'გაგზავნილია', tone: 'green' as const }
        : { label: 'იგზავნება', tone: 'blue' as const }

  const finish = async () => {
    if (!confirm) return
    setBusy(true)
    try {
      await shipments.finish(s.id, confirm)
      toast('success', confirm === 'close' ? 'ზედნადები დასრულდა' : 'ზედნადები გაუქმდა')
      setConfirm(null)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const steps: { title: string; icon: ReactNode; status: StepStatus; detail: ReactNode; action?: ReactNode }[] = [
    {
      title: 'ზედნადების ატვირთვა RS.ge-ზე',
      icon: <FileText className="size-4" />,
      status: s.rs.status,
      detail: s.rs.status === 'ok' ? <>ზედნადები <b className="font-mono">№{s.waybillNumber}</b></> : s.rs.error ?? (s.rs.status === 'running' ? 'იტვირთება…' : 'მოლოდინში'),
      action: canAct && s.status === 'rs_failed' && (
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} onClick={() => shipments.run(s.id).catch((e: Error) => toast('error', e.message))}>
          ხელახლა ცდა
        </Button>
      ),
    },
    {
      title: 'მძღოლისთვის SMS-ის გაგზავნა',
      icon: <MessageSquare className="size-4" />,
      status: s.sms.status,
      detail:
        s.sms.status === 'ok'
          ? `გაეგზავნა ${s.sms.to}${s.sms.delivery && s.sms.delivery !== 'Pending' ? ` · ${SMS_DELIVERY[s.sms.delivery].label.toLowerCase()}` : ''}`
          : s.sms.error ?? (s.sms.status === 'running' ? 'იგზავნება…' : s.sms.status === 'skipped' ? 'გამოტოვებულია' : 'მოლოდინში'),
      action: canAct && (s.sms.status === 'failed' || smsLost) && (
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} onClick={() => shipments.retrySms(s.id).catch((e: Error) => toast('error', e.message))}>
          ხელახლა გაგზავნა
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
            {s.waybillState === 'closed' && <Badge tone="gray">დასრულებული</Badge>}
            {s.waybillState === 'cancelled' && <Badge tone="red">გაუქმებული</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            შექმნა {creator ? `${creator.firstName} ${creator.lastName}` : '—'} · {formatDateTime(s.createdAt)} · {x.carrier}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
        {canClose && (
          <Button variant="secondary" size="sm" icon={<CheckCheck className="size-3.5" />} onClick={() => setConfirm('close')}>
            დასრულება
          </Button>
        )}
        {canCancel && (
          <Button variant="secondary" size="sm" icon={<Ban className="size-3.5" />} onClick={() => setConfirm('cancel')}>
            გაუქმება
          </Button>
        )}
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
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">დეტალები</h2>
            <dl className="divide-y divide-separator text-sm">
              <Info k="კარიერი" v={x.carrier} />
              <Info k="მარშრუტი" v={x.route} />
              <Info k="მძღოლი" v={x.driver} />
              <Info k="პირადი ნომერი" v={driver?.personalId} mono />
              <Info k="ტელეფონი" v={driver?.phone} />
              <Info k="მანქანა" v={truck?.model} />
              <Info k="სახელმწიფო ნომერი" v={truck?.plateNumber} mono />
              <Info k="მისაბმელი" v={truck?.trailerNumber || undefined} mono />
              {s.items.map((i, k) => (
                <Info
                  key={k}
                  k={i.name || 'პროდუქტი'}
                  sub={[i.barCode, i.aId ? `აქციზი ${i.aTitle || i.aId}` : ''].filter(Boolean).join(' · ')}
                  v={`${qtyText(i.quantity, i.unitTxt)} × ${i.price.toFixed(2)} ₾${i.quantityExt ? ` · დამატ. ${formatNumber(i.quantityExt, 3)}` : ''}`}
                />
              ))}
              {s.items.length > 1 && <Info k="სულ" v={formatNumber(s.quantity, 3)} />}
            </dl>
          </Card>

          {(w || r) && (
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">ზედნადები RS.ge-ზე</h2>
                <div className="flex items-center gap-1.5">
                  {rStatus && <Badge tone={rStatus.tone}>{rStatus.label}</Badge>}
                  {readable && (
                    <button
                      type="button"
                      onClick={() => void readRs()}
                      disabled={rsReading}
                      title="RS.ge-დან განახლება"
                      aria-label="RS.ge-დან განახლება"
                      className="grid size-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60"
                    >
                      <RefreshCw className={cx('size-3.5', rsReading && 'animate-spin')} />
                    </button>
                  )}
                </div>
              </div>
              {r ? (
                <dl className="divide-y divide-separator text-sm">
                  <Info k="მყიდველი" v={r.buyerName} />
                  <Info k="მყიდველის ს/ნ" v={r.buyerTin} mono />
                  <Info k="მარშრუტი" v={`${r.startAddress || '—'} → ${r.endAddress || '—'}`} changed={!!w && (r.startAddress.trim() !== w.startAddress.trim() || r.endAddress.trim() !== w.endAddress.trim())} />
                  <Info k="მძღოლი" v={r.driverName ? `${r.driverName} (${r.driverTin})` : r.driverTin} changed={!!w && r.driverTin !== w.driverTin} />
                  <Info k="მანქანა" v={r.carNumber} mono changed={!!w && plateKey(r.carNumber) !== plateKey(w.carNumber)} />
                  {r.goods.length > 1 && r.goods.map((g, k) => <Info key={k} k={g.name || 'პროდუქტი'} sub={g.barCode} v={qtyText(g.quantity, g.unitTxt)} />)}
                  <Info k={r.goods.length > 1 ? 'სულ' : 'რაოდენობა'} v={qtyText(r.quantity, rUnit)} changed={r.quantity !== s.quantity} />
                  {rGood && r.goods.length === 1 && <Info k="ფასი" v={`${rGood.price.toFixed(2)} ₾`} />}
                  <Info k="თანხა" v={`${r.fullAmount.toFixed(2)} ₾`} changed={!!w && Math.abs(r.fullAmount - sentAmount) >= 0.005} />
                  {r.activatedAt && <Info k="გააქტიურდა" v={formatDateTime(r.activatedAt)} />}
                  {r.correctedAt && <Info k="კორექტირდა" v={formatDateTime(r.correctedAt)} />}
                  {r.deliveredAt && <Info k="მიწოდება" v={formatDateTime(r.deliveredAt)} />}
                  {r.closedAt && <Info k={r.status === 2 ? 'დასრულდა' : 'დაიხურა'} v={formatDateTime(r.closedAt)} />}
                  {r.comment && <Info k="კომენტარი" v={r.comment} />}
                  {s.rsWaybillId && <Info k="RS.ge ID" v={String(s.rsWaybillId)} mono />}
                </dl>
              ) : (
                w && (
                  <dl className="divide-y divide-separator text-sm">
                    <Info k="მყიდველი" v={w.buyerName} />
                    <Info k="მყიდველის ს/ნ" v={w.buyerTin} mono />
                    {w.transporterTin && <Info k="გადამზიდავის ს/ნ" v={w.transporterTin} mono />}
                    <Info k="თანხა" v={good && `${sentAmount.toFixed(2)} ₾`} />
                    {w.comment && <Info k="კომენტარი" v={w.comment} />}
                    {s.rsWaybillId && <Info k="RS.ge ID" v={String(s.rsWaybillId)} mono />}
                  </dl>
                )
              )}
              {readable && (
                <p className={cx('mt-3 text-xs', rsError ? 'text-amber-700' : 'text-slate-400')}>
                  {rsError
                    ? `RS.ge-დან ვერ განახლდა: ${rsError}${r ? ` · ნაჩვენებია ${formatDateTime(r.checkedAt)}-ის მდგომარეობა` : ''}`
                    : r
                      ? `RS.ge-დან წაკითხულია ${formatDateTime(r.checkedAt)}`
                      : 'RS.ge-დან იკითხება…'}
                </p>
              )}
            </Card>
          )}

          {s.sms.text && (
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">SMS მძღოლს</h2>
                <Badge tone={smsBadge.tone}>{smsBadge.label}</Badge>
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-3 text-sm text-slate-800">{s.sms.text}</div>
              <p className="mt-2 text-xs text-slate-400">მიმღები: {s.sms.to}</p>
            </Card>
          )}
        </div>
      </div>

      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => void finish()}
        busy={busy}
        title={confirm === 'close' ? 'დასრულდეს ზედნადები?' : 'გაუქმდეს ზედნადები?'}
        confirmLabel={confirm === 'close' ? 'დასრულება' : 'გაუქმება'}
        message={
          confirm === 'close'
            ? `ზედნადები №${s.waybillNumber} RS.ge-ზე მოინიშნება მიწოდებულად. ამის შემდეგ მისი შეცვლა აღარ იქნება შესაძლებელი.`
            : `ზედნადები №${s.waybillNumber} RS.ge-ზე გაუქმდება${s.waybillState === 'closed' ? ', მიუხედავად იმისა, რომ დასრულებულია' : ''}. ეს მოქმედება შეუქცევადია.`
        }
      />
    </>
  )
}

/** `changed`: the value differs from what this app sent (the waybill was corrected on RS.ge). */
function Info({ k, v, mono, changed, sub }: { k: string; v?: string; mono?: boolean; changed?: boolean; sub?: string }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className={cx('text-slate-500', sub ? 'min-w-0 [overflow-wrap:anywhere]' : 'shrink-0')}>
        {k}
        {sub && <span className="block font-mono text-xs text-slate-400">{sub}</span>}
      </dt>
      <dd className="min-w-0 text-right">
        <span className={cx('text-slate-900 [overflow-wrap:anywhere]', mono && 'font-mono text-[13px]')}>{v ?? '—'}</span>
        {changed && <span className="block text-xs text-amber-700">შეცვლილია RS.ge-ზე</span>}
      </dd>
    </div>
  )
}
