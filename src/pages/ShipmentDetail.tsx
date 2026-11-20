import { ArrowLeft, Ban, CalendarClock, CheckCheck, Copy, CopyPlus, FileText, MessageSquare, PencilLine, Play, Printer, ReceiptText, RotateCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { shipments } from '../api'
import { Badge, Button, Card, RefreshButton, ConfirmModal, DeleteButton, EmptyState, Input, Modal, Segmented, ShipmentBadge, StepIcon } from '../components/ui'
import { useToast } from '../components/toast'
import { canUseCarrier } from '../lib/route'
import { cx, formatDateTime, formatNumber, fromTbilisiInput, toTbilisiInput } from '../lib/util'
import { useLookup } from '../lib/lookup'
import { editable, itemAmount, MAX_DEFER_MS, plateKey, RS_STATUS, waybillTypeLabel } from '../lib/rs'
import { SMS_DELIVERY, SMS_FINAL } from '../lib/sms'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { StepStatus } from '../types'

type Dialog = null | 'activate' | 'close' | 'cancel' | 'delete' | 'invoice'

export function ShipmentDetail() {
  const { id } = useParams()
  const user = useUser()
  const d = useDb()
  const L = useLookup()
  const nav = useNavigate()
  const toast = useToast()
  const s = d.shipments.find((x) => x.id === id)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [rsReading, setRsReading] = useState(false)
  const [rsError, setRsError] = useState('')

  // Opening a shipment on RS.ge reads its waybill from there, so changes made on the rs.ge portal show here.
  const readable = !!s && (s.status === 'uploaded' || s.status === 'saved') && !!s.rsWaybillId
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
  const live = !s.waybillState
  const isDraft = s.status === 'saved' && live && !!s.rsWaybillId
  const isActive = s.status === 'uploaded' && live && !!s.rsWaybillId
  const onRs = s.status === 'uploaded' && !!s.rsWaybillId
  const type = s.rsRemote?.type ?? s.rsWaybill?.type ?? s.waybill?.type
  const begin = s.rsRemote?.beginAt ?? s.waybill?.beginAt
  const canInvoice = canAct && onRs && s.waybillState !== 'cancelled' && type !== 1 && !s.invoiceId
  // What was sent: kept only until RS.ge has the waybill (then RS.ge's copy is all there is).
  const w = s.rsWaybill
  const sentAmount = w ? w.goods.reduce((a, g) => a + g.amount, 0) : 0
  const r = s.rsRemote
  // The quantity's unit, when every goods line has the same one.
  const rUnit = r && new Set(r.goods.map((g) => g.unitTxt)).size === 1 ? r.goods[0]?.unitTxt : undefined
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

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', ok)
      setDialog(null)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const rsDetail =
    s.status === 'saved'
      ? s.waybillState === 'cancelled'
        ? 'RS.ge-ზე შენახული ზედნადები წაიშალა'
        : `შენახულია RS.ge-ზე (ID ${s.rsWaybillId}) — გასააქტიურებელია`
      : s.rs.status === 'ok'
        ? (
            <>
              ზედნადები <b className="font-mono">№{s.waybillNumber}</b>
              {begin && Date.parse(begin) > Date.now() && <> · ტრანსპორტირება იწყება {formatDateTime(begin)}</>}
            </>
          )
        : (s.rs.error ?? (s.rs.status === 'running' ? 'იტვირთება…' : 'მოლოდინში'))

  const steps: { title: string; icon: ReactNode; status: StepStatus; detail: ReactNode; action?: ReactNode }[] = [
    {
      title: s.draft || s.status === 'saved' ? 'ზედნადების შენახვა RS.ge-ზე' : 'ზედნადების ატვირთვა RS.ge-ზე',
      icon: <FileText className="size-4" />,
      status: s.status === 'saved' && live ? 'ok' : s.rs.status,
      detail: rsDetail,
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
          : (s.sms.error ??
            (s.sms.status === 'running'
              ? 'იგზავნება…'
              : s.sms.status === 'skipped'
                ? 'ტრანსპორტირების გარეშე — მძღოლი არ არის'
                : s.status === 'saved'
                  ? 'გაიგზავნება გააქტიურებისას'
                  : 'მოლოდინში')),
      action: canAct && (s.sms.status === 'failed' || smsLost) && (
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} onClick={() => shipments.retrySms(s.id).catch((e: Error) => toast('error', e.message))}>
          ხელახლა გაგზავნა
        </Button>
      ),
    },
  ]

  const printable = (s.status === 'uploaded' || isDraft) && !!s.rsWaybillId
  const title = s.waybillNumber ? `№ ${s.waybillNumber}` : s.status === 'saved' ? 'შენახული ზედნადები' : 'ზედნადები მოლოდინშია'

  return (
    <>
      <Link to="/shipments" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> რეისები
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className={cx('text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl', s.waybillNumber && 'font-mono')}>{title}</h1>
            <ShipmentBadge s={s} />
            {type && <Badge tone="gray">{waybillTypeLabel(type)}</Badge>}
            {s.invoiceId && <Badge tone="blue">ფაქტურა №{s.invoiceId}</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            შექმნა {creator ? `${creator.firstName} ${creator.lastName}` : '—'} · {formatDateTime(s.createdAt)} · {x.carrier}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canAct && isDraft && (
            <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => setDialog('activate')}>
              გააქტიურება
            </Button>
          )}
          {canAct && isActive && (
            <Button size="sm" icon={<CheckCheck className="size-3.5" />} onClick={() => setDialog('close')}>
              დასრულება
            </Button>
          )}
          {canAct && editable(s) && (
            <Button variant="secondary" size="sm" icon={<PencilLine className="size-3.5" />} onClick={() => nav(`/shipments/${s.id}/edit`)}>
              {isActive ? 'კორექტირება' : 'რედაქტირება'}
            </Button>
          )}
          {canInvoice && (
            <Button variant="secondary" size="sm" icon={<ReceiptText className="size-3.5" />} onClick={() => setDialog('invoice')}>
              ანგარიშ-ფაქტურა
            </Button>
          )}
          {printable && (
            <Button variant="secondary" size="sm" icon={<Printer className="size-3.5" />} onClick={() => window.open(`#/print/${s.rsWaybillId}`, '_blank')}>
              ბეჭდვა
            </Button>
          )}
          {s.waybillNumber && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Copy className="size-3.5" />}
              title="ნომრის კოპირება"
              aria-label="ნომრის კოპირება"
              onClick={() => {
                navigator.clipboard?.writeText(s.waybillNumber!).then(() => toast('success', 'ზედნადების ნომერი დაკოპირდა'), () => {})
              }}
            >
              №
            </Button>
          )}
          {canAct && (
            <Button variant="secondary" size="sm" icon={<CopyPlus className="size-3.5" />} onClick={() => nav(`/new?from=${s.id}`)} title="ახალი რეისი იგივე მონაცემებით">
              ასლი
            </Button>
          )}
          {canAct && isDraft && <DeleteButton onClick={() => setDialog('delete')} />}
          {canAct && onRs && s.waybillState !== 'cancelled' && !s.invoiceId && (
            <Button variant="secondaryDanger" size="sm" icon={<Ban className="size-3.5" />} onClick={() => setDialog('cancel')}>
              გაუქმება
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
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

          {(w || r || readable) && (
            <Card className="p-5 sm:p-6">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">ზედნადები RS.ge-ზე</h2>
                <div className="flex items-center gap-1.5">
                  {rStatus && <Badge tone={rStatus.tone}>{rStatus.label}</Badge>}
                  {r?.confirmed === 1 && <Badge tone="green">მყიდველმა დაადასტურა</Badge>}
                  {r?.confirmed === -1 && <Badge tone="red">მყიდველი არ ეთანხმება</Badge>}
                  {readable && <RefreshButton busy={rsReading} onClick={() => void readRs()} />}
                </div>
              </div>
              {/* Goods as RS.ge has them (else as sent; nothing while RS.ge's copy is being read). */}
              {(r || w) && (
                <>
                  <div className="-mx-1 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-500">
                          <th className="px-1 py-1.5 font-medium">საქონელი</th>
                          <th className="px-1 py-1.5 text-right font-medium">რაოდ.</th>
                          <th className="hidden px-1 py-1.5 text-right font-medium sm:table-cell">ფასი</th>
                          <th className="px-1 py-1.5 text-right font-medium">თანხა</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-separator">
                        {(r?.goods ?? w?.goods ?? []).map((g, k) => (
                          <tr key={k}>
                            <td className="px-1 py-2">
                              <p className="text-slate-900">{g.name}</p>
                              <p className="font-mono text-xs text-slate-400">{g.barCode}</p>
                              <p className="text-xs text-slate-500 sm:hidden">{g.price.toFixed(2)} ₾ / {g.unitTxt}</p>
                            </td>
                            <td className="px-1 py-2 text-right whitespace-nowrap tabular-nums">{qtyText(g.quantity, g.unitTxt)}</td>
                            <td className="hidden px-1 py-2 text-right whitespace-nowrap tabular-nums sm:table-cell">{g.price.toFixed(2)}</td>
                            <td className="px-1 py-2 text-right whitespace-nowrap tabular-nums">{g.amount.toFixed(2)} ₾</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-separator font-medium text-slate-900">
                          <td className="px-1 py-2">სულ</td>
                          <td className="px-1 py-2 text-right tabular-nums">
                            {qtyText(r?.quantity ?? s.quantity, rUnit)}
                            {r && r.quantity !== s.quantity && <span className="block text-xs font-normal text-amber-700">შეცვლილია RS.ge-ზე</span>}
                          </td>
                          <td className="hidden sm:table-cell" />
                          <td className="px-1 py-2 text-right tabular-nums">
                            {(r?.fullAmount ?? sentAmount).toFixed(2)} ₾
                            {r && w && Math.abs(r.fullAmount - sentAmount) >= 0.005 && <span className="block text-xs font-normal text-amber-700">შეცვლილია RS.ge-ზე</span>}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {r?.fullAmountText && <p className="mt-1 text-xs text-slate-500">{r.fullAmountText}</p>}
                  <dl className="mt-3 divide-y divide-separator text-sm">
                    <Info k="მყიდველი" v={(r ?? w)!.buyerName ? `${(r ?? w)!.buyerName} (${(r ?? w)!.buyerTin})` : (r ?? w)!.buyerTin} />
                    {r ? (
                      <>
                        <Info k="მარშრუტი" v={`${r.startAddress || '—'} → ${r.endAddress || '—'}`} changed={!!w && (r.startAddress.trim() !== w.startAddress.trim() || r.endAddress.trim() !== w.endAddress.trim())} />
                        {(r.driverTin || r.carNumber) && (
                          <>
                            <Info k="მძღოლი" v={r.driverName ? `${r.driverName} (${r.driverTin})` : r.driverTin} changed={!!w && r.driverTin !== w.driverTin} />
                            <Info k="მანქანა" v={r.carNumber} mono changed={!!w && plateKey(r.carNumber) !== plateKey(w.carNumber)} />
                          </>
                        )}
                        {r.transportCost > 0 && <Info k="ტრანსპორტირება" v={`${r.transportCost.toFixed(2)} ₾ · იხდის ${r.tranCostPayer === 1 ? 'მყიდველი' : 'გამყიდველი'}`} />}
                        {r.receptionInfo && <Info k="მიმწოდებელი" v={r.receptionInfo} />}
                        {r.receiverInfo && <Info k="მიმღები" v={r.receiverInfo} />}
                        {r.createdAt && <Info k="შეიქმნა" v={formatDateTime(r.createdAt)} />}
                        {r.activatedAt && r.status !== 0 && <Info k="გააქტიურდა" v={formatDateTime(r.activatedAt)} />}
                        {r.beginAt && r.status !== 0 && <Info k="ტრანსპორტირების დაწყება" v={formatDateTime(r.beginAt)} />}
                        {r.correctedAt && <Info k="კორექტირდა" v={formatDateTime(r.correctedAt)} />}
                        {r.deliveredAt && <Info k="მიწოდება" v={formatDateTime(r.deliveredAt)} />}
                        {r.closedAt && <Info k={r.status === 2 ? 'დასრულდა' : 'დაიხურა'} v={formatDateTime(r.closedAt)} />}
                        {r.comment && <Info k="კომენტარი" v={r.comment} />}
                      </>
                    ) : (
                      w && (
                        <>
                          {w.transporterTin && <Info k="გადამზიდავის ს/ნ" v={w.transporterTin} mono />}
                          {w.comment && <Info k="კომენტარი" v={w.comment} />}
                        </>
                      )
                    )}
                    {s.rsWaybillId && <Info k="RS.ge ID" v={String(s.rsWaybillId)} mono />}
                  </dl>
                </>
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
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">დეტალები</h2>
            <dl className="divide-y divide-separator text-sm">
              <Info k="კარიერი" v={x.carrier} />
              <Info k="მარშრუტი" v={x.route} />
              {driver ? (
                <>
                  <Info k="მძღოლი" v={x.driver} />
                  <Info k="პირადი ნომერი" v={driver.personalId} mono />
                  <Info k="ტელეფონი" v={driver.phone} />
                </>
              ) : (
                <Info k="ტრანსპორტირება" v="გარეშე" />
              )}
              {truck && (
                <>
                  <Info k="მანქანა" v={truck.model} />
                  <Info k="სახელმწიფო ნომერი" v={truck.plateNumber} mono />
                  <Info k="მისაბმელი" v={truck.trailerNumber || undefined} mono />
                </>
              )}
              {s.items.map((i, k) => (
                <Info
                  key={k}
                  k={i.name || 'პროდუქტი'}
                  sub={[i.barCode, i.aId ? `აქციზი ${i.aTitle || i.aId}` : ''].filter(Boolean).join(' · ')}
                  v={`${qtyText(i.quantity, i.unitTxt)} × ${i.price.toFixed(2)} ₾ = ${itemAmount(i).toFixed(2)} ₾${i.quantityExt ? ` · დამატ. ${formatNumber(i.quantityExt, 3)}` : ''}`}
                />
              ))}
              {s.items.length > 1 && <Info k="სულ" v={formatNumber(s.quantity, 3)} />}
            </dl>
          </Card>

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

      <ActivateModal open={dialog === 'activate'} busy={busy} onClose={() => setDialog(null)} onConfirm={(beginAt) => void run(() => shipments.activate(s.id, beginAt), 'ზედნადები იტვირთება RS.ge-ზე…')} />
      <CloseModal open={dialog === 'close'} busy={busy} number={s.waybillNumber} begin={begin} onClose={() => setDialog(null)} onConfirm={(at) => void run(() => shipments.finish(s.id, 'close', at), 'ზედნადები დასრულდა')} />
      <ConfirmModal
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        onConfirm={() => void run(() => shipments.finish(s.id, 'cancel'), 'ზედნადები გაუქმდა')}
        busy={busy}
        title={`გაუქმდეს ზედნადები №${s.waybillNumber}?`}
        confirmLabel="გაუქმება"
      />
      <ConfirmModal
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        onConfirm={() => void run(() => shipments.finish(s.id, 'delete'), 'შენახული ზედნადები წაიშალა')}
        busy={busy}
        title="წაიშალოს ზედნადები?"
        confirmLabel="წაშლა"
      />
      <InvoiceModal open={dialog === 'invoice'} busy={busy} begin={begin} onClose={() => setDialog(null)} onConfirm={() => void run(() => shipments.invoice(s.id), 'ანგარიშ-ფაქტურა გამოიწერა')} />
    </>
  )
}

/** Issuing the invoice of a waybill: possible once its transport has started. */
export function InvoiceModal({ open, busy, begin, onClose, onConfirm }: { open: boolean; busy: boolean; begin?: string; onClose: () => void; onConfirm: () => void }) {
  const started = !begin || Date.parse(begin) <= Date.now()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="გამოიწეროს ანგარიშ-ფაქტურა?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            გაუქმება
          </Button>
          <Button loading={busy} disabled={!started} icon={<ReceiptText className="size-4" />} onClick={onConfirm}>
            გამოწერა
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-slate-600">
        <p>ზედნადებს ვეღარ შეცვლი და ვეღარ გააუქმებ.</p>
        {!started && <p className="text-rose-600">შესაძლებელია {formatDateTime(begin)}-დან.</p>}
      </div>
    </Modal>
  )
}

/** Activation of a draft: now, or from a planned time up to 3 days ahead. */
export function ActivateModal({ open, busy, onClose, onConfirm }: { open: boolean; busy: boolean; onClose: () => void; onConfirm: (beginAt?: string) => void }) {
  const [mode, setMode] = useState<'now' | 'later'>('now')
  const [at, setAt] = useState(() => toTbilisiInput(new Date(Date.now() + 3600_000)))
  const iso = fromTbilisiInput(at)
  const t = Date.parse(iso)
  const error = mode === 'later' ? (!iso ? 'აირჩიე დრო' : t < Date.now() ? 'დრო უკვე გავიდა' : t > Date.now() + MAX_DEFER_MS - 5 * 60_000 ? 'მაქსიმუმ 3 დღით ადრე' : '') : ''
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="გააქტიურდეს ზედნადები?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            გაუქმება
          </Button>
          <Button loading={busy} disabled={!!error} icon={mode === 'later' ? <CalendarClock className="size-4" /> : <Play className="size-4" />} onClick={() => onConfirm(mode === 'later' ? iso : undefined)}>
            გააქტიურება
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-600">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'now', label: 'ახლავე' },
            { value: 'later', label: 'დაგეგმილი დაწყება' },
          ]}
        />
        {mode === 'later' && (
          <div>
            <Input type="datetime-local" value={at} min={toTbilisiInput()} max={toTbilisiInput(new Date(Date.now() + MAX_DEFER_MS - 10 * 60_000))} invalid={!!error} onChange={(e) => setAt(e.target.value)} />
            {error && <p className="mt-1 ml-1 text-xs text-rose-600">{error}</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Completing a waybill: delivered now, or at an earlier time (not before the start of transport). */
export function CloseModal({ open, busy, number, begin, onClose, onConfirm }: { open: boolean; busy: boolean; number?: string; begin?: string; onClose: () => void; onConfirm: (deliveredAt?: string) => void }) {
  const [mode, setMode] = useState<'now' | 'at'>('now')
  const [at, setAt] = useState(() => toTbilisiInput())
  const iso = fromTbilisiInput(at)
  const t = Date.parse(iso)
  const notStarted = !!begin && Date.parse(begin) > Date.now()
  const error =
    mode === 'at' ? (!iso ? 'აირჩიე დრო' : t > Date.now() + 60_000 ? 'მიწოდება მომავალში ვერ იქნება' : begin && t < Date.parse(begin) ? 'მიწოდება ტრანსპორტირების დაწყებამდე ვერ იქნება' : '') : ''
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`დასრულდეს ზედნადები №${number}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            გაუქმება
          </Button>
          <Button loading={busy} disabled={!!error || notStarted} icon={<CheckCheck className="size-4" />} onClick={() => onConfirm(mode === 'at' ? iso : undefined)}>
            დასრულება
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-600">
        {notStarted ? (
          <p className="text-rose-600">შესაძლებელია {formatDateTime(begin)}-დან.</p>
        ) : (
          <>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'now', label: 'მიწოდებულია ახლა' },
                { value: 'at', label: 'სხვა დრო' },
              ]}
            />
            {mode === 'at' && (
              <div>
                <Input type="datetime-local" value={at} min={begin ? toTbilisiInput(begin) : undefined} max={toTbilisiInput()} invalid={!!error} onChange={(e) => setAt(e.target.value)} />
                {error && <p className="mt-1 ml-1 text-xs text-rose-600">{error}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** `changed`: the value differs from what this app sent (the waybill was corrected on RS.ge). */
function Info({ k, v, mono, changed, sub }: { k: string; v?: string; mono?: boolean; changed?: boolean; sub?: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2.5">
      <dt className="min-w-0 text-slate-500 [overflow-wrap:anywhere]">
        {k}
        {sub && <span className="block font-mono text-xs text-slate-400">{sub}</span>}
      </dt>
      <dd className="ml-auto min-w-0 text-right">
        <span className={cx('text-slate-900 [overflow-wrap:anywhere]', mono && 'font-mono text-[13px]')}>{v ?? '—'}</span>
        {changed && <span className="block text-xs text-amber-700">შეცვლილია RS.ge-ზე</span>}
      </dd>
    </div>
  )
}
