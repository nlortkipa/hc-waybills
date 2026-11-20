import { Ban, CheckCheck, ChevronRight, Download, ExternalLink, FileText, Loader2, Play, Printer, ReceiptText, Search, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { rsWaybills, type RsWaybillAction, type RsWaybillDetail } from '../api'
import { useDb } from '../api/store'
import { Badge, Button, Card, ConfirmModal, DeleteButton, EmptyState, Input, Modal, PageHeader, RefreshButton, Select } from '../components/ui'
import { DateRange } from '../components/DateRange'
import { useToast } from '../components/toast'
import { RS_STATUS, waybillTypeLabel } from '../lib/rs'
import { formatDateTime, formatNumber, shiftMonths, tbilisiDay, tbilisiStamp, formatMoney } from '../lib/util'
import { downloadXlsx } from '../lib/xlsx'
import { openPrint } from '../lib/save'
import { useUser } from '../session'
import type { RsListWaybill } from '../types'
import { ActivateModal, CloseModal, InvoiceModal } from './ShipmentDetail'

type Side = 'issued' | 'received'
type StatusFilter = 'all' | '0' | '1' | '2' | 'off'

const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'ყველა სტატუსი' },
  { value: '0', label: 'შენახული' },
  { value: '1', label: 'აქტიური' },
  { value: '2', label: 'დასრულებული' },
  { value: 'off', label: 'გაუქმებული' },
]

/** Rows shown at first, and added by "show more". */
const PAGE = 100

const statusOf = (n: number) => RS_STATUS[n] ?? { label: String(n), tone: 'gray' as const }

/**
 * The taxpayer's waybills on RS.ge, whoever made them (this app, the rs.ge portal, another system):
 * issued (გაცემული) and received (მიღებული), as on the portal. Admins act on them as there.
 */
export function RsWaybills() {
  const user = useUser()
  const d = useDb()
  const toast = useToast()
  const [side, setSide] = useState<Side>('issued')
  // Days in Georgian time, both included: by default the last month (this day of the previous month to today).
  const [from, setFrom] = useState(() => shiftMonths(tbilisiDay(), -1))
  const [to, setTo] = useState(tbilisiDay)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<RsListWaybill[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const connected = !!d.rs.sellerTin

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const start = new Date(`${from}T00:00:00+04:00`)
      const end = new Date(`${to}T23:59:59.999+04:00`)
      setRows(await rsWaybills.list(side, start.toISOString(), end.toISOString()))
    } catch (e) {
      setError((e as Error).message)
      setRows(null)
    } finally {
      setLoading(false)
    }
  }, [side, from, to])

  useEffect(() => {
    if (connected) void load()
  }, [load, connected])
  // A new filter starts from the top.
  const [filterKey, setFilterKey] = useState('')
  const key = `${side}|${from}|${to}|${status}|${q}`
  if (key !== filterKey) {
    setFilterKey(key)
    setLimit(PAGE)
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (rows ?? []).filter((r) => {
      if (status === 'off' ? r.status >= 0 : status !== 'all' && r.status !== Number(status)) return false
      if (!needle) return true
      return [r.number, r.buyerName, r.buyerTin, r.sellerName, r.sellerTin, r.carNumber, r.driverName, r.driverTin, r.startAddress, r.endAddress, r.comment].some((v) => v?.toLowerCase().includes(needle))
    })
  }, [rows, status, q])
  const page = shown.slice(0, limit)
  const total = shown.reduce((a, r) => a + (r.status >= 0 ? r.fullAmount : 0), 0)
  const party = (r: RsListWaybill) => (side === 'issued' ? { name: r.buyerName, tin: r.buyerTin } : { name: r.sellerName, tin: r.sellerTin })

  const exportXlsx = async () => {
    const err = await downloadXlsx(`rs-${side === 'issued' ? 'gacemuli' : 'migebuli'}-${from}_${to}.xlsx`, [
      ['ნომერი', 'ტიპი', 'სტატუსი', 'შექმნა', 'გააქტიურება', side === 'issued' ? 'მყიდველი' : 'გამყიდველი', 'ს/ნ', 'საიდან', 'სად', 'მძღოლი', 'მანქანა', 'თანხა', 'კომენტარი'],
      ...shown.map((r) => [
        r.number,
        waybillTypeLabel(r.type),
        statusOf(r.status).label,
        r.createdAt ? tbilisiStamp(r.createdAt) : '',
        r.activatedAt ? tbilisiStamp(r.activatedAt) : '',
        party(r).name,
        party(r).tin,
        r.startAddress,
        r.endAddress,
        r.driverName,
        r.carNumber,
        r.fullAmount,
        r.comment,
      ]),
    ], side === 'issued' ? 'გაცემული' : 'მიღებული')
    if (err) toast('error', err)
  }

  return (
    <>
      <PageHeader
        title="RS.ge ზედნადებები"
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<Download className="size-3.5" />} onClick={() => void exportXlsx()} disabled={!shown.length}>
              Excel
            </Button>
            <RefreshButton busy={loading} onClick={() => void load()} disabled={!connected} />
          </>
        }
      />
      {!connected ? (
        <Card>
          <EmptyState icon={<FileText />} title="RS.ge არ არის დაკავშირებული" text={user.role === 'admin' ? 'დაუკავშირდი RS.ge-ს პარამეტრებში.' : 'მიმართე ადმინისტრატორს.'} />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="grid w-full grid-cols-[2fr_3fr] gap-2 sm:flex sm:w-auto sm:shrink-0">
                <Select
                  aria-label="გაცემული ან მიღებული"
                  value={side}
                  onChange={(e) => {
                    setSide(e.target.value as Side)
                    setRows(null)
                  }}
                  className="sm:w-32"
                >
                  <option value="issued">გაცემული</option>
                  <option value="received">მიღებული</option>
                </Select>
                <Select aria-label="სტატუსი" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="sm:w-44">
                  {STATUSES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} maxMonths={2} />
              <div className="relative w-full min-w-56 sm:w-auto sm:flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ნომერი, კომპანია, მანქანა, მისამართი…" className="pl-9" />
              </div>
            </div>
            {rows && (
              <p className="text-xs text-slate-500">
                {shown.length} ზედნადები{shown.length !== rows.length && ` (სულ ${rows.length})`} · {formatMoney(total)} ₾
              </p>
            )}
          </div>

          {error ? (
            <p className="px-5 pb-5 text-sm text-rose-600">{error}</p>
          ) : !rows ? (
            <p className="flex items-center gap-2 px-5 pb-6 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> RS.ge-დან იკითხება…
            </p>
          ) : !shown.length ? (
            <EmptyState icon={<FileText />} title="ზედნადები ვერ მოიძებნა" text="სცადე სხვა პერიოდი ან ფილტრი." />
          ) : (
            <>
              <div className="hidden overflow-x-auto xl:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-separator text-left text-xs text-slate-500">
                      <th className="px-5 py-3 font-medium">ნომერი</th>
                      <th className="px-3 py-3 font-medium">{side === 'issued' ? 'მყიდველი' : 'გამყიდველი'}</th>
                      <th className="px-3 py-3 font-medium">მარშრუტი</th>
                      <th className="px-3 py-3 font-medium">მანქანა</th>
                      <th className="px-3 py-3 text-right font-medium">თანხა</th>
                      <th className="px-3 py-3 font-medium">სტატუსი</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-separator">
                    {page.map((r) => (
                      <tr key={r.id} onClick={() => setOpen(r.id)} className="cursor-pointer hover:bg-slate-50/80">
                        <td className="px-5 py-2.5">
                          <p className="font-mono text-[13px] font-medium text-slate-900">{r.number || '—'}</p>
                          <p className="text-xs whitespace-nowrap text-slate-500">{formatDateTime(r.activatedAt ?? r.createdAt)}</p>
                          <p className="text-xs text-slate-500">{waybillTypeLabel(r.type)}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="text-slate-800">{party(r).name || '—'}</p>
                          <p className="font-mono text-xs text-slate-400">{party(r).tin}</p>
                        </td>
                        <td className="max-w-64 px-3 py-2.5 text-slate-700">
                          <p className="truncate">{r.startAddress || '—'}</p>
                          <p className="truncate text-slate-500">→ {r.endAddress || '—'}</p>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[13px] text-slate-700">{r.carNumber || '—'}</td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums text-slate-800">{formatMoney(r.fullAmount)} ₾</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={statusOf(r.status).tone} dot>
                              {statusOf(r.status).label}
                            </Badge>
                            {r.shipmentId && <Badge tone="violet">HC</Badge>}
                            {r.confirmed === 1 && <Badge tone="green">მიღებული</Badge>}
                            {r.confirmed === -1 && <Badge tone="red">უარყოფილი</Badge>}
                          </div>
                        </td>
                        <td className="pr-4">
                          <ChevronRight className="size-4 text-slate-300" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-separator xl:hidden">
                {page.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => setOpen(r.id)} className="w-full px-4 py-3 text-left active:bg-slate-50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-mono text-sm font-semibold text-slate-900">{r.number || '—'}</p>
                          <p className="text-xs text-slate-500">
                            {formatDateTime(r.activatedAt ?? r.createdAt)} · {waybillTypeLabel(r.type)}
                          </p>
                        </div>
                        <Badge tone={statusOf(r.status).tone} dot>
                          {statusOf(r.status).label}
                        </Badge>
                      </div>
                      <p className="mt-1.5 truncate text-[13px] text-slate-700">{party(r).name || party(r).tin || '—'}</p>
                      <p className="truncate text-[13px] text-slate-500">
                        {r.endAddress || r.startAddress || '—'} · {r.carNumber || '—'} · {formatMoney(r.fullAmount)} ₾
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
              {shown.length > limit && (
                <div className="hairline-t flex justify-center p-3">
                  <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                    მეტის ჩვენება ({shown.length - limit})
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}
      {open != null && <WaybillSheet id={open} side={side} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </>
  )
}

/** One waybill read from RS.ge, with what can be done to it. */
function WaybillSheet({ id, side, onClose, onChanged }: { id: number; side: Side; onClose: () => void; onChanged: () => void }) {
  const user = useUser()
  const toast = useToast()
  const [w, setW] = useState<RsWaybillDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<null | 'activate' | 'close' | 'cancel' | 'delete' | 'invoice' | 'reject'>(null)

  useEffect(() => {
    rsWaybills.get(id).then(setW, (e: Error) => setError(e.message))
  }, [id])

  const act = async (action: RsWaybillAction, body: { beginAt?: string; deliveredAt?: string } | undefined, ok: string) => {
    setBusy(true)
    try {
      setW(await rsWaybills.act(id, action, body))
      toast('success', ok)
      setDialog(null)
      onChanged()
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const admin = user.role === 'admin'
  const mine = side === 'issued'
  const st = w && statusOf(w.status)

  return (
    <>
      <Modal open={!dialog} onClose={onClose} title={w ? `ზედნადები №${w.number || w.id}` : 'ზედნადები'} wide>
        {error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : !w ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="size-4 animate-spin" /> RS.ge-დან იკითხება…
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={st!.tone} dot>
                {st!.label}
              </Badge>
              <Badge>{waybillTypeLabel(w.type)}</Badge>
              {w.correctedAt && <Badge tone="amber">კორექტირებული</Badge>}
              {w.invoiceId && <Badge tone="blue">ფაქტურა №{w.invoiceId}</Badge>}
              {w.confirmed === 1 && <Badge tone="green">მყიდველმა დაადასტურა</Badge>}
              {w.confirmed === -1 && <Badge tone="red">მყიდველი არ ეთანხმება</Badge>}
              {w.shipmentId && (
                <Link to={`/shipments/${w.shipmentId}`} onClick={onClose} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600">
                  რეისი <ExternalLink className="size-3" />
                </Link>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {admin && mine && w.status === 0 && (
                <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => setDialog('activate')}>
                  გააქტიურება
                </Button>
              )}
              {admin && mine && w.status === 1 && (
                <Button size="sm" icon={<CheckCheck className="size-3.5" />} onClick={() => setDialog('close')}>
                  დასრულება
                </Button>
              )}
              {admin && !mine && w.status > 0 && w.confirmed !== 1 && (
                <Button size="sm" icon={<ThumbsUp className="size-3.5" />} loading={busy} onClick={() => void act('confirm', undefined, 'ზედნადები დადასტურდა')}>
                  მივიღე
                </Button>
              )}
              {admin && !mine && w.status > 0 && w.confirmed !== -1 && (
                <Button size="sm" variant="secondary" icon={<ThumbsDown className="size-3.5" />} onClick={() => setDialog('reject')}>
                  არ ვეთანხმები
                </Button>
              )}
              {admin && mine && (w.status === 1 || w.status === 2) && w.type !== 1 && !w.invoiceId && (
                <Button size="sm" variant="secondary" icon={<ReceiptText className="size-3.5" />} onClick={() => setDialog('invoice')}>
                  ანგარიშ-ფაქტურა
                </Button>
              )}
              {w.status >= 0 && (
                <Button size="sm" variant="secondary" icon={<Printer className="size-3.5" />} onClick={() => w.id && openPrint(w.id)}>
                  ბეჭდვა
                </Button>
              )}
              {admin && mine && w.status === 0 && <DeleteButton onClick={() => setDialog('delete')} />}
              {admin && mine && (w.status === 1 || w.status === 2) && !w.invoiceId && (
                <Button size="sm" variant="secondaryDanger" icon={<Ban className="size-3.5" />} onClick={() => setDialog('cancel')}>
                  გაუქმება
                </Button>
              )}
            </div>

            <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
              <Item k="გამყიდველი" v={`${w.sellerName || '—'}${w.sellerTin ? ` (${w.sellerTin})` : ''}`} />
              <Item k="მყიდველი" v={`${w.buyerName || '—'}${w.buyerTin ? ` (${w.buyerTin})` : ''}`} />
              <Item k="საიდან" v={w.startAddress} />
              <Item k="სად" v={w.endAddress} />
              <Item k="მძღოლი" v={w.driverName ? `${w.driverName} (${w.driverTin})` : w.driverTin} />
              <Item k="მანქანა" v={w.carNumber} />
              <Item k="შექმნა" v={w.createdAt && formatDateTime(w.createdAt)} />
              <Item k="ტრანსპორტირების დაწყება" v={w.beginAt && formatDateTime(w.beginAt)} />
              {w.deliveredAt && <Item k="მიწოდება" v={formatDateTime(w.deliveredAt)} />}
              {w.closedAt && <Item k={w.status === 2 ? 'დასრულდა' : 'დაიხურა'} v={formatDateTime(w.closedAt)} />}
              {w.transportCost > 0 && <Item k="ტრანსპორტირება" v={`${formatMoney(w.transportCost)} ₾`} />}
              {w.comment && <Item k="კომენტარი" v={w.comment} />}
            </dl>

            <div className="overflow-x-auto rounded-[10px] ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="px-3 py-2 font-medium">საქონელი</th>
                    <th className="px-3 py-2 text-right font-medium">რაოდ.</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">ფასი</th>
                    <th className="px-3 py-2 text-right font-medium">თანხა</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-separator">
                  {w.goods.map((g, k) => (
                    <tr key={k}>
                      <td className="px-3 py-2">
                        <p className="text-slate-900">{g.name}</p>
                        <p className="font-mono text-xs text-slate-400">{g.barCode}</p>
                        <p className="text-xs text-slate-500 sm:hidden">{formatMoney(g.price)} ₾ / {g.unitTxt}</p>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                        {formatNumber(g.quantity, 3)} {g.unitTxt}
                      </td>
                      <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{formatMoney(g.price)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(g.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-separator font-medium">
                    <td className="px-3 py-2">სულ</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(w.quantity, 3)}</td>
                    <td className="hidden sm:table-cell" />
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(w.fullAmount)} ₾</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {w.fullAmountText && <p className="text-xs text-slate-500">{w.fullAmountText}</p>}
          </div>
        )}
      </Modal>

      {w && (
        <>
          <ActivateModal open={dialog === 'activate'} busy={busy} onClose={() => setDialog(null)} onConfirm={(beginAt) => void act('activate', { beginAt }, 'ზედნადები გააქტიურდა')} />
          <CloseModal open={dialog === 'close'} busy={busy} number={w.number} begin={w.beginAt} onClose={() => setDialog(null)} onConfirm={(at) => void act('close', { deliveredAt: at }, 'ზედნადები დასრულდა')} />
          <ConfirmModal
            open={dialog === 'cancel'}
            busy={busy}
            onClose={() => setDialog(null)}
            onConfirm={() => void act('cancel', undefined, 'ზედნადები გაუქმდა')}
            title={`გაუქმდეს ზედნადები №${w.number}?`}
            confirmLabel="გაუქმება"
          />
          <ConfirmModal
            open={dialog === 'delete'}
            busy={busy}
            onClose={() => setDialog(null)}
            onConfirm={() => void act('delete', undefined, 'ზედნადები წაიშალა')}
            title="წაიშალოს ზედნადები?"
            confirmLabel="წაშლა"
          />
          <ConfirmModal
            open={dialog === 'reject'}
            busy={busy}
            onClose={() => setDialog(null)}
            onConfirm={() => void act('reject', undefined, 'ზედნადები უარყოფილია')}
            title="არ ეთანხმები ზედნადებს?"
            confirmLabel="არ ვეთანხმები"
            message={`${w.sellerName} ამას RS.ge-ზე დაინახავს.`}
          />
          <InvoiceModal open={dialog === 'invoice'} busy={busy} begin={w.beginAt} onClose={() => setDialog(null)} onConfirm={() => void act('invoice', undefined, 'ანგარიშ-ფაქტურა გამოიწერა')} />
        </>
      )}
    </>
  )
}

function Item({ k, v }: { k: string; v?: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-b border-separator py-2">
      <dt className="min-w-0 text-slate-500">{k}</dt>
      <dd className="ml-auto min-w-0 text-right [overflow-wrap:anywhere] text-slate-900">{v || '—'}</dd>
    </div>
  )
}
