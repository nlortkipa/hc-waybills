import { ArrowRight, FileUp, Info, Plus, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { shipments, usableCarriers, type NewShipmentItem } from '../api'
import { Button, Card, Field, Input, PageHeader, Select } from '../components/ui'
import { active, formatNumber } from '../lib/util'
import { routeLabel, routeUsable } from '../lib/route'
import { rsMissing } from '../lib/rs'
import { useToast } from '../components/toast'
import { useDb } from '../api/store'
import { useUser } from '../session'

/** A quantity as typed: a number above 0, else null. Accepts a comma as the decimal sign. */
const qty = (v: string) => {
  const n = Number(v.trim().replace(',', '.'))
  return v.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null
}

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
  // The route's goods lines (set by the admin in ცნობარები → მარშრუტები): the operator types each
  // quantity and drops the lines this truck doesn't carry. Another route starts over.
  const routeGoods = route?.goods ?? []
  const defaultQty = d.rs.quantity > 0 ? String(d.rs.quantity) : ''
  const [entry, setEntry] = useState<{ routeId: string; qty: Record<string, string>; ext: Record<string, string>; removed: string[] }>({ routeId: '', qty: {}, ext: {}, removed: [] })
  const cur = entry.routeId === (route?.id ?? '') ? entry : { routeId: route?.id ?? '', qty: {} as Record<string, string>, ext: {} as Record<string, string>, removed: [] as string[] }
  const update = (patch: Partial<typeof cur>) => setEntry({ ...cur, ...patch })
  const qtyOf = (lineId: string) => cur.qty[lineId] ?? defaultQty
  const shown = routeGoods.filter((g) => !cur.removed.includes(g.id))
  const hidden = routeGoods.filter((g) => cur.removed.includes(g.id))

  // The additional quantity is optional: empty is fine, anything typed must be a number above 0.
  const extOf = (lineId: string) => cur.ext[lineId] ?? ''
  const lines = shown.map((g) => ({ key: g.id, name: g.name, unit: g.unitTxt, price: g.price, quantity: qty(qtyOf(g.id)), ext: extOf(g.id).trim() ? qty(extOf(g.id)) : undefined }))
  const complete = lines.length > 0 && lines.every((l) => l.quantity)
  const total = complete ? lines.reduce((a, l) => a + l.quantity!, 0) : null
  const amount = complete ? lines.reduce((a, l) => a + Math.round(l.quantity! * l.price * 100) / 100, 0) : null
  // Operators don't see the service user, so only check what they can see; the server checks the rest.
  const rsNotReady = rsMissing(d.rs, { hasCreds: true }).length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!carrier) err.carrierId = 'აირჩიე კარიერი'
    else if (!route) err.routeId = 'აირჩიე მარშრუტი'
    if (!form.driverId) err.driverId = 'აირჩიე მძღოლი'
    if (!form.truckId) err.truckId = 'აირჩიე მანქანა'
    if (route && !routeGoods.length) err.routeId = 'ამ მარშრუტს პროდუქტები არ აქვს — მიმართე ადმინისტრატორს'
    else if (route && !lines.length) err.items = 'რეისზე მინიმუმ ერთი პროდუქტი უნდა იყოს'
    for (const l of lines) {
      if (!l.quantity) err[`${l.key}.quantity`] = 'რაოდენობა: შეიყვანე 0-ზე მეტი'
      else if (l.ext === null) err[`${l.key}.quantity`] = 'დამატებითი რაოდენობა: შეიყვანე 0-ზე მეტი ან დატოვე ცარიელი'
    }
    setErrors(err)
    if (Object.keys(err).length || !carrier || !route) return
    const items: NewShipmentItem[] = lines.map((l) => ({ lineId: l.key, quantity: l.quantity!, ...(l.ext && { quantityExt: l.ext }) }))
    setBusy(true)
    try {
      const id = await shipments.create({ carrierId: carrier.id, routeId: route.id, driverId: form.driverId, truckId: form.truckId, items }, user)
      toast('info', 'ზედნადები იტვირთება RS.ge-ზე…')
      nav(`/shipments/${id}`)
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="ახალი რეისი" subtitle="აირჩიე კარიერი, მარშრუტი, პროდუქტები, მძღოლი და მანქანა, შემდეგ ატვირთე ზედნადები RS.ge-ზე." />
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

            <Field
              label="მარშრუტი"
              error={errors.routeId}
              hint={
                carrier && !routes.length
                  ? 'ამ კარიერს მარშრუტი ჯერ არ აქვს — სთხოვე ადმინისტრატორს დამატება.'
                  : route && !routeGoods.length
                    ? 'ამ მარშრუტს პროდუქტები არ აქვს — მიმართე ადმინისტრატორს.'
                    : undefined
              }
            >
              <Select value={route?.id ?? ''} onChange={set('routeId')} placeholder={carrier ? 'აირჩიე მარშრუტი…' : 'ჯერ აირჩიე კარიერი'} invalid={!!errors.routeId} disabled={!routes.length}>
                {routes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {routeLabel(d.carriers, x)}
                    {x.goods.length ? ` · ${x.goods.length === 1 ? x.goods[0].name : `${x.goods.length} პროდუქტი`}` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {route && routeGoods.length > 0 && (
              <div>
                <p className="mb-1.5 ml-1 text-[13px] text-slate-500">პროდუქტები</p>
                <div className="divide-y divide-separator rounded-[10px] ring-1 ring-slate-200">
                  {shown.map((g) => {
                    const error = errors[`${g.id}.quantity`]
                    return (
                      <div key={g.id} className="px-3 py-2.5">
                        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                          <div className="min-w-0 flex-1 basis-full self-center sm:basis-0">
                            <p className="text-sm font-medium [overflow-wrap:anywhere] text-slate-900">{g.name}</p>
                            <p className="text-xs text-slate-500">
                              <span className="font-mono">{g.barCode}</span> · {g.price.toFixed(2)} ₾ / {g.unitTxt}
                              {g.aId ? ' · აქციზური' : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-end gap-2">
                            <label className="block w-28">
                              <span className="mb-1 block truncate text-[11px] text-slate-500" title={`რაოდენობა · ${g.unitTxt}`}>
                                რაოდ. · {g.unitTxt}
                              </span>
                              <Input
                                type="text"
                                inputMode="decimal"
                                value={qtyOf(g.id)}
                                invalid={!!error}
                                onChange={(e) => {
                                  update({ qty: { ...cur.qty, [g.id]: e.target.value } })
                                  setErrors((x) => ({ ...x, [`${g.id}.quantity`]: '' }))
                                }}
                                className="text-right"
                              />
                            </label>
                            <label className="block w-24" title="დამატებითი რაოდენობა (არასავალდებულო)">
                              <span className="mb-1 block truncate text-[11px] text-slate-500">დამატ. რაოდ.</span>
                              <Input
                                type="text"
                                inputMode="decimal"
                                value={extOf(g.id)}
                                placeholder="—"
                                onChange={(e) => {
                                  update({ ext: { ...cur.ext, [g.id]: e.target.value } })
                                  setErrors((x) => ({ ...x, [`${g.id}.quantity`]: '' }))
                                }}
                                className="text-right"
                              />
                            </label>
                          </div>
                          {routeGoods.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                update({ removed: [...cur.removed, g.id] })
                                setErrors((x) => ({ ...x, [`${g.id}.quantity`]: '' }))
                              }}
                              className="-mr-1 mb-1.5 shrink-0 self-end rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              aria-label={`${g.name}: მოხსნა`}
                              title="ამ რეისზე არ მიაქვს"
                            >
                              <X className="size-4" />
                            </button>
                          )}
                        </div>
                        {error && <p className="mt-1 text-right text-xs text-rose-600">{error}</p>}
                      </div>
                    )
                  })}
                  {!shown.length && <p className="px-3 py-2.5 text-sm text-slate-500">ყველა პროდუქტი მოხსნილია.</p>}
                </div>
                {hidden.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="ml-1 text-xs text-slate-500">მოხსნილი:</span>
                    {hidden.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          update({ removed: cur.removed.filter((x) => x !== g.id) })
                          setErrors((x) => ({ ...x, items: '' }))
                        }}
                        className="inline-flex h-7 items-center gap-1 rounded-full bg-fill px-2.5 text-xs text-slate-700 hover:bg-slate-200"
                      >
                        <Plus className="size-3.5" />
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}
                {errors.items && <p className="mt-1 ml-1 text-xs text-rose-600">{errors.items}</p>}
              </div>
            )}

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

            {rsNotReady && (
              <div className="rounded-[10px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">RS.ge პარამეტრები (ტრანსპორტი) არ არის შევსებული — მიმართე ადმინისტრატორს.</div>
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
              {lines.length ? (
                lines.map((l) => <Row key={l.key} k={l.name || 'პროდუქტი'} v={l.quantity ? `${formatNumber(l.quantity, 3)}${l.unit ? ` ${l.unit}` : ''}` : undefined} />)
              ) : (
                <Row k="პროდუქტი" />
              )}
              {lines.length > 1 && <Row k="სულ" v={total ? formatNumber(total, 3) : undefined} />}
              <Row k="თანხა" v={amount != null ? `${amount.toFixed(2)} ₾` : undefined} />
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

