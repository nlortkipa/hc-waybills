import { ArrowRight, FileUp, Info } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { shipments } from '../api'
import { Button, Card, Field, PageHeader, Select } from '../components/ui'
import { formatTonnes } from '../lib/util'
import { useToast } from '../components/toast'
import { useDb } from '../mock/db'
import { useUser } from '../session'

export function NewShipment() {
  const user = useUser()
  const d = useDb()
  const nav = useNavigate()
  const toast = useToast()
  const [carrierId, setCarrierId] = useState(user.carrierId ?? d.carriers[0]?.id ?? '')
  const [form, setForm] = useState({ destinationId: '', driverId: '', truckId: '', })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const carrier = d.carriers.find((c) => c.id === carrierId)
  const destinations = carrier?.destinations ?? []
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }

  const destination = destinations.find((x) => x.id === form.destinationId)
  const driver = d.drivers.find((r) => r.id === form.driverId)
  const truck = d.trucks.find((r) => r.id === form.truckId)
  const item = d.cargo.description ? d.cargo : undefined

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!form.destinationId) err.destinationId = 'აირჩიე დასრულების მისამართი'
    if (!form.driverId) err.driverId = 'აირჩიე მძღოლი'
    if (!form.truckId) err.truckId = 'აირჩიე მანქანა'
    setErrors(err)
    if (Object.keys(err).length) return
    setBusy(true)
    try {
      const id = await shipments.create({ carrierId, destinationId: form.destinationId, driverId: form.driverId, truckId: form.truckId }, user)
      toast('info', 'ზედნადები იტვირთება RS.ge-ზე…')
      nav(`/shipments/${id}`)
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="ახალი რეისი" subtitle="აირჩიე დასრულების მისამართი, მძღოლი და მანქანა, შემდეგ ატვირთე ზედნადები RS.ge-ზე." />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card className="p-5 sm:p-6">
          <form onSubmit={submit} className="space-y-5" noValidate>
            {user.role === 'admin' ? (
              <Field label="კარიერი">
                <Select
                  value={carrierId}
                  onChange={(e) => {
                    setCarrierId(e.target.value)
                    setForm((f) => ({ ...f, destinationId: '' }))
                  }}
                >
                  {d.carriers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <div className="rounded-[10px] bg-fill px-4 py-3 text-sm">
                <span className="text-slate-500">კარიერი: </span>
                <span className="font-medium text-slate-900">{d.carriers.find((c) => c.id === carrierId)?.name ?? '—'}</span>
              </div>
            )}

            <div className="rounded-[10px] bg-fill px-4 py-3 text-sm">
              <span className="text-slate-500">დაწყების მისამართი: </span>
              <span className="font-medium text-slate-900">{carrier?.startAddress || '—'}</span>
            </div>

            <Field label="დასრულების მისამართი" error={errors.destinationId} hint={destinations.length ? undefined : 'ამ კარიერს დასრულების მისამართი ჯერ არ აქვს — სთხოვე ადმინისტრატორს დამატება.'}>
              <Select value={form.destinationId} onChange={set('destinationId')} invalid={!!errors.destinationId}>
                <option value="">აირჩიე დასრულების მისამართი…</option>
                {destinations.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.address} · {x.scaleId}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="მძღოლი" error={errors.driverId}>
                <Select value={form.driverId} onChange={set('driverId')} invalid={!!errors.driverId}>
                  <option value="">აირჩიე მძღოლი…</option>
                  {d.drivers.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.firstName} {x.lastName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="მანქანა" error={errors.truckId}>
                <Select value={form.truckId} onChange={set('truckId')} invalid={!!errors.truckId}>
                  <option value="">აირჩიე მანქანა…</option>
                  {d.trucks.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.plateNumber} · {x.model}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="rounded-[10px] bg-fill px-4 py-3 text-sm">
              <span className="text-slate-500">ტვირთი: </span>
              <span className="font-medium text-slate-900">{item ? `${item.description} · ${formatTonnes(d.cargo.quantity)}` : 'არ არის დაყენებული — მიმართე ადმინისტრატორს'}</span>
            </div>

            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={() => nav(-1)}>
                გაუქმება
              </Button>
              <Button type="submit" size="lg" loading={busy} icon={<FileUp className="size-5" />}>
                ზედნადების ატვირთვა
              </Button>
            </div>
          </form>
        </Card>

        {/* Summary */}
        <div className="space-y-4">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">შეჯამება</h3>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row k="მარშრუტი" v={destination ? `${carrier?.startAddress} → ${destination.address}` : undefined} />
              <Row k="სასწორის ID" v={destination?.scaleId} mono />
              <Row k="მძღოლი" v={driver ? `${driver.firstName} ${driver.lastName}` : undefined} />
              <Row k="მძღოლის ტელ." v={driver?.phone} />
              <Row k="მანქანა" v={truck ? `${truck.plateNumber}` : undefined} mono />
              <Row k="მისაბმელი" v={truck?.trailerNumber} mono />
              <Row k="ტვირთი" v={item?.description} />
              <Row k="დეკლარირებული" v={item ? formatTonnes(d.cargo.quantity) : undefined} />
            </dl>
          </Card>
          <div className="flex gap-3 rounded-2xl bg-brand-50 p-4 text-sm text-brand-900 ring-1 ring-brand-100">
            <Info className="mt-0.5 size-4 shrink-0 text-brand-500" />
            <div>
              <p className="font-medium">რა მოხდება შემდეგ</p>
              <p className="mt-1 flex flex-wrap items-center gap-1 text-brand-800">
                RS.ge <ArrowRight className="size-3" /> SMS მძღოლს <ArrowRight className="size-3" /> სასწორი <ArrowRight className="size-3" /> რეალური წონა
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function Row({ k, v, mono }: { k: string; v?: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{k}</dt>
      <dd className={`truncate text-right ${v ? 'text-slate-900' : 'text-slate-300'} ${mono ? 'font-mono text-[13px]' : ''}`}>{v ?? '—'}</dd>
    </div>
  )
}
