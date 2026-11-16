import { AlertTriangle, Download, FileText, MessageSquare, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { visibleShipments } from '../api'
import { Button, Card, DatePicker, Field, PageHeader, Select, Stat, statusMeta } from '../components/ui'
import { cx, downloadCsv, formatDay, formatTonnes } from '../lib/util'
import { useLookup } from '../lib/lookup'
import { useDb } from '../api/store'
import { useUser } from '../session'

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

export function Reports() {
  const user = useUser()
  const d = useDb()
  const L = useLookup()
  const [from, setFrom] = useState(() => dayKey(new Date(Date.now() - 6 * 86400_000)))
  const [to, setTo] = useState(() => dayKey(new Date()))
  const [carrier, setCarrier] = useState('')

  const rows = useMemo(
    () =>
      visibleShipments(d, user).filter((s) => {
        const k = s.createdAt.slice(0, 10)
        return k >= from && k <= to && (!carrier || s.carrierId === carrier)
      }),
    [d, user, from, to, carrier],
  )
  const uploaded = useMemo(() => rows.filter((s) => s.status === 'uploaded'), [rows])
  const declaredT = uploaded.reduce((a, s) => a + s.quantity, 0)
  const smsSent = rows.filter((s) => s.sms.status === 'ok').length
  const failed = rows.filter((s) => s.status === 'rs_failed' || s.sms.status === 'failed').length

  // Daily declared tonnage of uploaded waybills
  const days = useMemo(() => {
    const out: { key: string; label: string; t: number; n: number }[] = []
    const start = new Date(from + 'T00:00:00Z')
    const end = new Date(to + 'T00:00:00Z')
    for (let t = start.getTime(); t <= end.getTime() && out.length < 62; t += 86400_000) {
      const dt = new Date(t)
      out.push({ key: dayKey(dt), label: formatDay(dt, true), t: 0, n: 0 })
    }
    for (const s of uploaded) {
      const b = out.find((x) => x.key === s.createdAt.slice(0, 10))
      if (b) {
        b.t += s.quantity
        b.n++
      }
    }
    return out
  }, [from, to, uploaded])
  const max = Math.max(1, ...days.map((x) => x.t))

  const byCarrier = useMemo(() => {
    const m = new Map<string, { n: number; uploaded: number; t: number; failed: number }>()
    for (const s of rows) {
      const e = m.get(s.carrierId) ?? { n: 0, uploaded: 0, t: 0, failed: 0 }
      e.n++
      if (s.status === 'uploaded') {
        e.uploaded++
        e.t += s.quantity
      }
      if (s.status === 'rs_failed') e.failed++
      m.set(s.carrierId, e)
    }
    return [...m.entries()].sort((a, b) => b[1].t - a[1].t)
  }, [rows])

  const exportCsv = () => {
    downloadCsv(`hc-report-${from}_${to}.csv`, [
      ['ზედნადები', 'შექმნის დრო', 'კარიერი', 'მარშრუტი', 'მძღოლი', 'მანქანის ნომერი', 'ტვირთი', 'დეკლარირებული (ტ)', 'SMS', 'სტატუსი'],
      ...rows.map((s) => {
        const x = L.describe(s)
        return [s.waybillNumber ?? '', s.createdAt, x.carrier, x.route, x.driver, x.plate, x.item, s.quantity, s.sms.status === 'ok' ? 'გაგზავნილი' : s.sms.status === 'failed' ? 'შეცდომა' : '', statusMeta[s.status].label]
      }),
    ])
  }

  return (
    <>
      <PageHeader
        title="რეპორტები"
        subtitle="რეისები და ატვირთული ზედნადებები არჩეული პერიოდისთვის."
        actions={
          <Button variant="secondary" icon={<Download className="size-4" />} onClick={exportCsv} disabled={!rows.length}>
            CSV<span className="hidden sm:inline"> ექსპორტი</span>
          </Button>
        }
      />

      <Card className="mb-6 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="დან">
            <DatePicker value={from} max={to} onChange={setFrom} />
          </Field>
          <Field label="მდე">
            <DatePicker value={to} min={from} onChange={setTo} />
          </Field>
          <div className="col-span-2 sm:col-span-1">
            <Field label="კარიერი">
              <Select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                <option value="">ყველა კარიერი</option>
                {d.carriers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.deletedAt ? ' (წაშლილი)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Stat label="რეისები" value={rows.length} sub={`${uploaded.length} ატვირთული`} icon={<Truck className="size-5" />} />
        <Stat label="დეკლარირებული" value={formatTonnes(declaredT)} sub="ატვირთული ზედნადებებით" icon={<FileText className="size-5" />} accent="bg-emerald-50 text-emerald-600" />
        <Stat label="SMS" value={smsSent} sub="გაეგზავნა მძღოლს" icon={<MessageSquare className="size-5" />} accent="bg-slate-100 text-slate-600" />
        <Stat label="შეცდომით" value={failed} sub="RS.ge ან SMS" icon={<AlertTriangle className="size-5" />} accent="bg-amber-50 text-amber-600" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-slate-900">დეკლარირებული ტონაჟი დღეების მიხედვით</h2>
          <p className="text-xs text-slate-500">ტონა, რეისის შექმნის თარიღით</p>
          <div className="mt-5 flex h-48 items-end gap-[2px]" role="img" aria-label="დეკლარირებული ტონაჟი დღეების მიხედვით">
            {days.map((x) => (
              <div key={x.key} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end">
                <div
                  className={cx('w-full rounded-t-[4px] transition-colors', x.t ? 'bg-brand-500 group-hover:bg-brand-600' : 'bg-slate-100')}
                  style={{ height: x.t ? `${Math.max(3, (x.t / max) * 100)}%` : '2px' }}
                />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 material rounded-[10px] px-2.5 py-1.5 text-xs whitespace-nowrap text-slate-900 shadow-lg ring-[0.5px] ring-black/10 dark:ring-white/10 group-hover:block">
                  <p className="font-medium">{x.label}</p>
                  <p className="text-slate-500">
                    {formatTonnes(x.t)} · {x.n} მანქანა
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between border-t border-separator pt-2 text-[11px] text-slate-400">
            <span>{days[0]?.label}</span>
            {days.length > 2 && <span>{days[Math.floor(days.length / 2)]?.label}</span>}
            <span>{days[days.length - 1]?.label}</span>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-separator px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">კარიერების მიხედვით</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">კარიერი</th>
                <th className="px-2 py-2 text-right font-medium">მანქანა</th>
                <th className="px-5 py-2 text-right font-medium">ტონაჟი</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {byCarrier.map(([id, e]) => (
                <tr key={id}>
                  <td className="px-5 py-2.5">
                    <p className="font-medium text-slate-900">{L.carrier(id)?.name}</p>
                    {e.failed > 0 && <p className="text-xs text-rose-600">{e.failed} შეცდომით</p>}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-slate-600">
                    {e.uploaded}/{e.n}
                  </td>
                  <td className="px-5 py-2.5 text-right font-medium tabular-nums text-slate-900">{formatTonnes(e.t)}</td>
                </tr>
              ))}
              {!byCarrier.length && (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-slate-400">
                    ამ პერიოდში მონაცემები არ არის
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  )
}
