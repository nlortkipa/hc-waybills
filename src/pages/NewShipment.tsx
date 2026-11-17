import { ArrowRight, FileUp, Info } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { shipments, usableCarriers } from '../api'
import { Button, Card, Field, PageHeader, Select } from '../components/ui'
import { active, formatTonnes } from '../lib/util'
import { routeLabel, routeUsable } from '../lib/route'
import { rsMissing } from '../lib/rs'
import { useToast } from '../components/toast'
import { useDb } from '../api/store'
import { useUser } from '../session'

export function NewShipment() {
  const user = useUser()
  const d = useDb()
  const nav = useNavigate()
  const toast = useToast()
  const carriers = usableCarriers(d, user)
  const [form, setForm] = useState({ carrierId: '', routeId: '', driverId: '', truckId: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  // With a single carrier or route there is nothing to choose: it is preselected.
  const carrier = carriers.find((c) => c.id === form.carrierId) ?? (carriers.length === 1 ? carriers[0] : undefined)
  const routes = carrier ? d.routes.filter((x) => x.carrierId === carrier.id && routeUsable(d.carriers, x)) : []
  const route = routes.find((x) => x.id === form.routeId) ?? (routes.length === 1 ? routes[0] : undefined)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    const v = e.target.value
    // Routes belong to a carrier: picking another carrier clears the route.
    setForm((f) => ({ ...f, [k]: v, ...(k === 'carrierId' ? { routeId: '' } : {}) }))
    setErrors((x) => ({ ...x, [k]: '', ...(k === 'carrierId' ? { routeId: '' } : {}) }))
  }

  const driver = d.drivers.find((r) => r.id === form.driverId)
  const truck = d.trucks.find((r) => r.id === form.truckId)
  const item = d.cargo.description ? d.cargo : undefined
  // Operators don't see the service user, so only check what they can see; the server checks the rest.
  const rsNotReady = rsMissing(d.rs, { hasCreds: true }).length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!carrier) err.carrierId = 'აირჩიე კარიერი'
    else if (!route) err.routeId = 'აირჩიე მარშრუტი'
    if (!form.driverId) err.driverId = 'აირჩიე მძღოლი'
    if (!form.truckId) err.truckId = 'აირჩიე მანქანა'
    setErrors(err)
    if (Object.keys(err).length || !carrier || !route) return
    setBusy(true)
    try {
      const id = await shipments.create({ carrierId: carrier.id, routeId: route.id, driverId: form.driverId, truckId: form.truckId }, user)
      toast('info', 'ზედნადები იტვირთება RS.ge-ზე…')
      nav(`/shipments/${id}`)
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="ახალი რეისი" subtitle="აირჩიე კარიერი, მარშრუტი, მძღოლი და მანქანა, შემდეგ ატვირთე ზედნადები RS.ge-ზე." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="p-5 sm:p-6">
          <form onSubmit={submit} className="space-y-5" noValidate>
            {carriers.length === 1 ? (
              <div className="rounded-[10px] bg-fill px-4 py-3 text-sm">
                <span className="text-slate-500">კარიერი: </span>
                <span className="font-medium text-slate-900">{carriers[0].name}</span>
              </div>
            ) : (
              <Field
                label="კარიერი"
                error={errors.carrierId}
                hint={carriers.length ? undefined : user.role === 'operator' ? 'შენ არცერთი კარიერი არ გაქვს მინიჭებული — მიმართე ადმინისტრატორს.' : 'კარიერები ჯერ არ არის — დაამატე ცნობარებში.'}
              >
                <Select value={carrier?.id ?? ''} onChange={set('carrierId')} placeholder="აირჩიე კარიერი…" invalid={!!errors.carrierId} disabled={!carriers.length}>
                  {carriers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="მარშრუტი" error={errors.routeId} hint={carrier && !routes.length ? 'ამ კარიერს მარშრუტი ჯერ არ აქვს — სთხოვე ადმინისტრატორს დამატება.' : undefined}>
              <Select value={route?.id ?? ''} onChange={set('routeId')} placeholder={carrier ? 'აირჩიე მარშრუტი…' : 'ჯერ აირჩიე კარიერი'} invalid={!!errors.routeId} disabled={!routes.length}>
                {routes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {routeLabel(d.carriers, x)}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="მძღოლი" error={errors.driverId}>
                <Select value={form.driverId} onChange={set('driverId')} placeholder="აირჩიე მძღოლი…" invalid={!!errors.driverId}>
                  {active(d.drivers).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.firstName} {x.lastName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="მანქანა" error={errors.truckId}>
                <Select value={form.truckId} onChange={set('truckId')} placeholder="აირჩიე მანქანა…" invalid={!!errors.truckId}>
                  {active(d.trucks).map((x) => (
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

            {rsNotReady && (
              <div className="rounded-[10px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">RS.ge პარამეტრები (მყიდველი, ერთეული, ფასი) არ არის შევსებული — მიმართე ადმინისტრატორს.</div>
            )}

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
              <Row k="კარიერი" v={carrier?.name} />
              <Row k="მარშრუტი" v={route ? routeLabel(d.carriers, route) : undefined} />
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
                RS.ge <ArrowRight className="size-3" /> SMS მძღოლს
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
      <dt className="shrink-0 text-slate-500">{k}</dt>
      <dd className={`min-w-0 text-right [overflow-wrap:anywhere] ${v ? 'text-slate-900' : 'text-slate-300'} ${mono ? 'font-mono text-[13px]' : ''}`}>{v ?? '—'}</dd>
    </div>
  )
}
