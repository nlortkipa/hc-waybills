import { Loader2, Printer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { rsWaybills, type RsWaybillDetail } from '../api'
import { Button } from '../components/ui'
import { RS_STATUS, waybillTypeLabel } from '../lib/rs'
import { formatDateTime, formatNumber } from '../lib/util'

/**
 * A waybill as RS.ge has it now, laid out for paper (A4): what the driver carries and the receiver
 * signs. Opened in its own tab from a shipment or the RS.ge registry; prints itself once loaded.
 */
export function PrintWaybill() {
  const { id } = useParams()
  const [w, setW] = useState<RsWaybillDetail | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    rsWaybills.get(Number(id)).then(setW, (e: Error) => setError(e.message))
  }, [id])
  useEffect(() => {
    if (!w) return
    document.title = `ზედნადები ${w.number || w.id}`
    const t = setTimeout(() => window.print(), 300)
    return () => clearTimeout(t)
  }, [w])

  if (error) return <p className="p-8 text-rose-600">{error}</p>
  if (!w)
    return (
      <p className="flex items-center gap-2 p-8 text-slate-500">
        <Loader2 className="size-4 animate-spin" /> RS.ge-დან იკითხება…
      </p>
    )

  const status = RS_STATUS[w.status]?.label ?? String(w.status)
  const cell = 'border border-black/70 px-2 py-1 align-top'
  return (
    <div className="min-h-dvh bg-white text-[12px] leading-snug text-black print:min-h-0">
      <div className="mx-auto max-w-[800px] p-6 print:max-w-none print:p-0">
        <div className="mb-4 flex justify-end print:hidden">
          <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
            ბეჭდვა
          </Button>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-bold">სასაქონლო ზედნადები №{w.number || '—'}</h1>
            <p>
              {waybillTypeLabel(w.type)} · {status}
              {w.correctedAt && ' · კორექტირებული'}
            </p>
          </div>
          <div className="text-right">
            <p>RS.ge ID: {w.id}</p>
            {w.createdAt && <p>შექმნა: {formatDateTime(w.createdAt)}</p>}
            {w.activatedAt && <p>გააქტიურება: {formatDateTime(w.activatedAt)}</p>}
          </div>
        </div>

        <table className="mt-4 w-full border-collapse">
          <tbody>
            <tr>
              <td className={`${cell} w-1/2`}>
                <p className="font-semibold">გამყიდველი (გამგზავნი)</p>
                <p>{w.sellerName || '—'}</p>
                <p>ს/ნ: {w.sellerTin || '—'}</p>
              </td>
              <td className={cell}>
                <p className="font-semibold">მყიდველი (მიმღები)</p>
                <p>{w.buyerName || '—'}</p>
                <p>ს/ნ: {w.buyerTin || '—'}</p>
              </td>
            </tr>
            <tr>
              <td className={cell}>
                <p className="font-semibold">ტრანსპორტირების დაწყების ადგილი</p>
                <p>{w.startAddress || '—'}</p>
              </td>
              <td className={cell}>
                <p className="font-semibold">ტრანსპორტირების დასრულების ადგილი</p>
                <p>{w.endAddress || '—'}</p>
              </td>
            </tr>
            <tr>
              <td className={cell}>
                <p className="font-semibold">მძღოლი</p>
                <p>{w.driverName || '—'}</p>
                <p>პ/ნ: {w.driverTin || '—'}</p>
              </td>
              <td className={cell}>
                <p className="font-semibold">სატრანსპორტო საშუალება</p>
                <p>{w.carNumber || '—'}</p>
                {w.transporterTin && <p>გადამზიდავი ს/ნ: {w.transporterTin}</p>}
              </td>
            </tr>
            <tr>
              <td className={cell}>
                <p className="font-semibold">ტრანსპორტირების დაწყება</p>
                <p>{w.beginAt ? formatDateTime(w.beginAt) : '—'}</p>
              </td>
              <td className={cell}>
                <p className="font-semibold">ტრანსპორტირების ღირებულება</p>
                <p>
                  {w.transportCost.toFixed(2)} ₾{w.transportCost > 0 && ` · იხდის ${w.tranCostPayer === 1 ? 'მყიდველი' : 'გამყიდველი'}`}
                </p>
              </td>
            </tr>
          </tbody>
        </table>

        <table className="mt-4 w-full border-collapse">
          <thead>
            <tr className="bg-black/5">
              <th className={`${cell} w-8 text-left`}>№</th>
              <th className={`${cell} text-left`}>საქონლის დასახელება</th>
              <th className={`${cell} text-left`}>კოდი</th>
              <th className={`${cell} text-left`}>ერთ.</th>
              <th className={`${cell} text-right`}>რაოდენობა</th>
              <th className={`${cell} text-right`}>ფასი</th>
              <th className={`${cell} text-right`}>თანხა</th>
            </tr>
          </thead>
          <tbody>
            {w.goods.map((g, k) => (
              <tr key={k}>
                <td className={cell}>{k + 1}</td>
                <td className={cell}>{g.name}</td>
                <td className={`${cell} font-mono`}>{g.barCode}</td>
                <td className={cell}>{g.unitTxt}</td>
                <td className={`${cell} text-right tabular-nums`}>{formatNumber(g.quantity, 3)}</td>
                <td className={`${cell} text-right tabular-nums`}>{g.price.toFixed(2)}</td>
                <td className={`${cell} text-right tabular-nums`}>{g.amount.toFixed(2)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className={cell} colSpan={4}>
                სულ
              </td>
              <td className={`${cell} text-right tabular-nums`}>{formatNumber(w.quantity, 3)}</td>
              <td className={cell} />
              <td className={`${cell} text-right tabular-nums`}>{w.fullAmount.toFixed(2)} ₾</td>
            </tr>
          </tbody>
        </table>
        {w.fullAmountText && <p className="mt-1">თანხა სიტყვიერად: {w.fullAmountText}</p>}

        {(w.receptionInfo || w.receiverInfo || w.comment) && (
          <div className="mt-3 space-y-0.5">
            {w.receptionInfo && <p>მიმწოდებლის ინფორმაცია: {w.receptionInfo}</p>}
            {w.receiverInfo && <p>მიმღების ინფორმაცია: {w.receiverInfo}</p>}
            {w.comment && <p>კომენტარი: {w.comment}</p>}
          </div>
        )}
        {w.deliveredAt && <p className="mt-2">მიწოდება: {formatDateTime(w.deliveredAt)}</p>}

        <div className="mt-12 grid grid-cols-3 gap-8">
          {['გადასცა', 'გადაიტანა (მძღოლი)', 'მიიღო'].map((x) => (
            <div key={x}>
              <div className="border-b border-black" />
              <p className="mt-1 text-center">{x} — ხელმოწერა</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
