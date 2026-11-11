import { ArrowRight, FileUp, Info } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { shipments } from '../api'
import { Button, Card, Field, Input, PageHeader, Select } from '../components/ui'
import { useToast } from '../components/toast'
import { useDb } from '../mock/db'
import { useUser } from '../session'

export function NewShipment() {
  const user = useUser()
  const d = useDb()
  const nav = useNavigate()
  const toast = useToast()
  const [carrierId, setCarrierId] = useState(user.carrierId ?? d.carriers[0]?.id ?? '')
  const [form, setForm] = useState({ routeId: '', driverId: '', truckId: '', itemId: d.items[0]?.id ?? '', quantity: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const routes = useMemo(() => d.routes.filter((r) => r.carrierId === carrierId), [d.routes, carrierId])
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }

  const route = d.routes.find((r) => r.id === form.routeId)
  const driver = d.drivers.find((r) => r.id === form.driverId)
  const truck = d.trucks.find((r) => r.id === form.truckId)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!form.routeId) err.routeId = 'აირჩიე მარშრუტი'
    if (!form.driverId) err.driverId = 'აირჩიე მძღოლი'
    if (!form.truckId) err.truckId = 'აირჩიე მანქანა'
    if (!form.itemId) err.itemId = 'აირჩიე ტვირთი'
    const q = Number(form.quantity)
    if (!form.quantity || !(q > 0) || q > 60) err.quantity = 'შეიყვანე რაოდენობა 0-დან 60 ტ-მდე'
    setErrors(err)
    if (Object.keys(err).length) return
    setBusy(true)
    try {
      const id = await shipments.create({ carrierId, routeId: form.routeId, driverId: form.driverId, truckId: form.truckId, itemId: form.itemId, quantity: q }, user)
      toast('info', 'ზედნადები იტვირთება RS.ge-ზე…')
      nav(`/shipments/${id}`)
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="ახალი რეისი" subtitle="აირჩიე მარშრუტი, მძღოლი და მანქანა, შემდეგ ატვირთე ზედნადები RS.ge-ზე." />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card className="p-5 sm:p-6">
          <form onSubmit={submit} className="space-y-5" noValidate>
            {user.role === 'admin' ? (
              <Field label="კარიერი">
                <Select
                  value={carrierId}
                  onChange={(e) => {
                    setCarrierId(e.target.value)
                    setForm((f) => ({ ...f, routeId: '' }))
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
              <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200/70">
                <span className="text-slate-500">კარიერი: </span>
                <span className="font-medium text-slate-900">{d.carriers.find((c) => c.id === carrierId)?.name ?? '—'}</span>
              </div>
            )}

            <Field label="მარშრუტი" error={errors.routeId} hint={routes.length ? undefined : 'ამ კარიერს მარშრუტი ჯერ არ აქვს — სთხოვე ადმინისტრატორს დამატება.'}>
              <Select value={form.routeId} onChange={set('routeId')} invalid={!!errors.routeId}>
                <option value="">აირჩიე მარშრუტი…</option>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.startLocation} → {r.endLocation}
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

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="ტვირთი" error={errors.itemId}>
                <Select value={form.itemId} onChange={set('itemId')} invalid={!!errors.itemId}>
                  {d.items.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.description}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="დეკლარირებული რაოდენობა (ტ)" error={errors.quantity}>
                <Input type="number" inputMode="decimal" step="0.1" min="0" placeholder="მაგ. 24.5" value={form.quantity} onChange={set('quantity')} invalid={!!errors.quantity} />
              </Field>
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
              <Row k="მარშრუტი" v={route ? `${route.startLocation} → ${route.endLocation}` : undefined} />
              <Row k="სასწორის ID" v={route?.name} mono />
              <Row k="მძღოლი" v={driver ? `${driver.firstName} ${driver.lastName}` : undefined} />
              <Row k="მძღოლის ტელ." v={driver?.phone} />
              <Row k="მანქანა" v={truck ? `${truck.plateNumber}` : undefined} mono />
              <Row k="მისაბმელი" v={truck?.trailerNumber} mono />
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
