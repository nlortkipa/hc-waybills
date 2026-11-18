import { ArrowLeft, CalendarClock, CheckCircle2, ChevronDown, FileCheck2, Info, Loader2, PencilLine, Plus, Save, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { rsPending, shipments, usableCarriers, useRsLoad, type NewShipmentInput, type NewShipmentItem } from '../api'
import { Button, Card, EmptyState, Field, Input, PageHeader, Segmented, Select } from '../components/ui'
import { LookupLine, useTinName } from '../components/TinLookup'
import { active, cx, formatDateTime, formatNumber, fromTbilisiInput, toTbilisiInput } from '../lib/util'
import { routeAddresses, routeLabel, routeUsable, canUseCarrier } from '../lib/route'
import { editable, MAX_DEFER_MS, noTransport, rsMissing, waybillDefaults, WAYBILL_TYPES, waybillTypeLabel } from '../lib/rs'
import { useToast } from '../components/toast'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { Database, Shipment, ShipmentWaybill, WaybillType } from '../types'

/** A quantity as typed: a number above 0, else null. Accepts a comma as the decimal sign. */
const qty = (v: string) => {
  const n = Number(v.trim().replace(',', '.'))
  return v.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null
}

/** Waybill fields as typed. */
type WaybillForm = {
  type: WaybillType
  buyerTin: string
  buyerName: string
  begin: 'now' | 'later'
  /** datetime-local, Georgian time. */
  beginAt: string
  transportCost: string
  tranCostPayer: '1' | '2'
  receptionInfo: string
  receiverInfo: string
  comment: string
}

const toWaybillForm = (w: ShipmentWaybill): WaybillForm => ({
  type: w.type,
  buyerTin: w.buyerTin,
  // RS.ge's own name is shown from the lookup; only a typed one is the user's.
  buyerName: w.buyerForeign ? w.buyerName : '',
  begin: w.beginAt && Date.parse(w.beginAt) > Date.now() ? 'later' : 'now',
  beginAt: w.beginAt && Date.parse(w.beginAt) > Date.now() ? toTbilisiInput(w.beginAt) : '',
  transportCost: w.transportCost ? String(w.transportCost) : '',
  tranCostPayer: String(w.tranCostPayer) as '1' | '2',
  receptionInfo: w.receptionInfo,
  receiverInfo: w.receiverInfo,
  comment: w.comment,
})

/** Where the form starts: empty, a copy of another shipment (`?from=`), or the shipment being edited. */
type Seed = { carrierId: string; routeId: string; driverId: string; truckId: string; qty: Record<string, string>; ext: Record<string, string>; removed: string[]; waybill?: Partial<WaybillForm> }

function seedFrom(d: Database, s: Shipment, keepBegin: boolean): Seed {
  const route = d.routes.find((r) => r.id === s.routeId)
  const inItems = new Set(s.items.map((i) => i.lineId))
  const w = s.waybill && toWaybillForm(s.waybill)
  return {
    carrierId: s.carrierId,
    routeId: s.routeId,
    driverId: s.driverId,
    truckId: s.truckId,
    qty: Object.fromEntries(s.items.filter((i) => i.lineId).map((i) => [i.lineId, String(i.quantity)])),
    ext: Object.fromEntries(s.items.filter((i) => i.lineId && i.quantityExt).map((i) => [i.lineId, String(i.quantityExt)])),
    removed: (route?.goods ?? []).filter((g) => !inItems.has(g.id)).map((g) => g.id),
    ...(w && { waybill: keepBegin ? w : { ...w, begin: 'now', beginAt: '' } }),
  }
}

/** Waiting for RS.ge's copy of a waybill: its goods and options are read from RS.ge, not stored here. */
function ReadingFromRs({ s }: { s: Shipment }) {
  useRsLoad([s])
  return <EmptyState icon={<Loader2 className="size-6 animate-spin" />} title="ზედნადები იკითხება RS.ge-დან…" text="პროდუქტები და პარამეტრები RS.ge-ზეა — ფორმა გაიხსნება, როგორც კი წაიკითხება." action={<Link to={`/shipments/${s.id}`} className="text-sm font-medium text-brand-600">რეისზე დაბრუნება</Link>} />
}

/** RS.ge's copy is needed before the form can start from this shipment (its goods are RS.ge's only). */
const needsRs = (s: Shipment) => rsPending(s) && !s.items.length

export function NewShipment() {
  const d = useDb()
  const user = useUser()
  const [params] = useSearchParams()
  const from = d.shipments.find((x) => x.id === params.get('from') && canUseCarrier(user, x.carrierId))
  if (from && needsRs(from)) return <ReadingFromRs s={from} />
  // A copy of another shipment: same route, people, goods and options; a new waybill.
  return <ShipmentForm key={from?.id ?? 'new'} seed={from ? seedFrom(d, from, false) : undefined} copiedFrom={from} />
}

export function EditShipment() {
  const { id } = useParams()
  const d = useDb()
  const user = useUser()
  const s = d.shipments.find((x) => x.id === id)
  if (!s || !canUseCarrier(user, s.carrierId) || user.role === 'report') {
    return <EmptyState icon={<PencilLine className="size-6" />} title="რეისი ვერ მოიძებნა" action={<Link to="/shipments" className="text-sm font-medium text-brand-600">რეისებზე დაბრუნება</Link>} />
  }
  if (needsRs(s)) return <ReadingFromRs s={s} />
  if (!editable(s)) {
    return (
      <EmptyState
        icon={<PencilLine className="size-6" />}
        title="ამ ზედნადების შეცვლა აღარ შეიძლება"
        text={s.invoiceId ? 'ზედნადებზე ანგარიშ-ფაქტურაა გამოწერილი.' : s.waybillState ? 'ზედნადები დასრულებული ან გაუქმებულია.' : 'რეისი ახლა მუშავდება.'}
        action={<Link to={`/shipments/${s.id}`} className="text-sm font-medium text-brand-600">რეისზე დაბრუნება</Link>}
      />
    )
  }
  return <ShipmentForm key={s.id} seed={seedFrom(d, s, true)} editing={s} />
}

/** The truck a driver drove last (and the other way round), so picking one suggests the other. */
function lastPair(d: Database, key: 'driverId' | 'truckId', id: string) {
  const other = key === 'driverId' ? 'truckId' : 'driverId'
  const s = [...d.shipments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((x) => x[key] === id && x[other])
  const pick = s?.[other]
  const list = other === 'truckId' ? d.trucks : d.drivers
  return pick && list.some((x) => x.id === pick && !x.deletedAt) ? pick : ''
}

function ShipmentForm({ seed, editing, copiedFrom }: { seed?: Seed; editing?: Shipment; copiedFrom?: Shipment }) {
  const user = useUser()
  const d = useDb()
  const nav = useNavigate()
  const toast = useToast()
  const carriers = usableCarriers(d, user)
  const [form, setForm] = useState({ carrierId: seed?.carrierId ?? '', routeId: seed?.routeId ?? '', driverId: seed?.driverId ?? '', truckId: seed?.truckId ?? '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'' | 'draft' | 'send'>('')
  const [more, setMore] = useState(false)
  // Active on RS.ge: a correction. Its type and start can't change there.
  const correcting = editing?.status === 'uploaded'

  // With a single carrier or route there is nothing to choose: it is preselected.
  const carrier = carriers.find((c) => c.id === form.carrierId) ?? (carriers.length === 1 ? carriers[0] : undefined) ?? (editing ? d.carriers.find((c) => c.id === editing.carrierId) : undefined)
  const routes = carrier ? d.routes.filter((x) => x.carrierId === carrier.id && (routeUsable(d.carriers, x) || x.id === editing?.routeId)) : []
  const route = routes.find((x) => x.id === form.routeId) ?? (routes.length === 1 ? routes[0] : undefined)
  const clear = (...keys: string[]) => setErrors((x) => ({ ...x, ...Object.fromEntries(keys.map((k) => [k, ''])) }))
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    const v = e.target.value
    setForm((f) => {
      const next = { ...f, [k]: v }
      // Routes belong to a carrier: picking another carrier clears the route.
      if (k === 'carrierId') next.routeId = ''
      // The truck this driver drove last (and the other way round), when none is picked yet.
      if (k === 'driverId' && v && !f.truckId) next.truckId = lastPair(d, 'driverId', v)
      if (k === 'truckId' && v && !f.driverId) next.driverId = lastPair(d, 'truckId', v)
      return next
    })
    // Another route has its own type and buyer.
    if (k === 'routeId' || k === 'carrierId') setWb(({ type: _t, buyerTin: _b, buyerName: _n, ...rest }) => rest)
    clear(k, ...(k === 'carrierId' ? ['routeId'] : []), ...(k === 'driverId' ? ['truckId'] : k === 'truckId' ? ['driverId'] : []))
  }

  const driver = d.drivers.find((r) => r.id === form.driverId)
  const truck = d.trucks.find((r) => r.id === form.truckId)
  // The route's goods lines (set by the admin in ცნობარები → მარშრუტები): the operator types each
  // quantity and drops the lines this truck doesn't carry. Another route starts over.
  const routeGoods = route?.goods ?? []
  type Entry = { routeId: string; qty: Record<string, string>; ext: Record<string, string>; removed: string[] }
  const [entry, setEntry] = useState<Entry>({ routeId: seed?.routeId ?? '', qty: seed?.qty ?? {}, ext: seed?.ext ?? {}, removed: seed?.removed ?? [] })
  const cur: Entry = entry.routeId === (route?.id ?? '') ? entry : { routeId: route?.id ?? '', qty: {}, ext: {}, removed: [] }
  const update = (patch: Partial<Entry>) => setEntry({ ...cur, ...patch })
  // A line's own quantity, if the admin set one, is prefilled.
  const qtyOf = (lineId: string) => cur.qty[lineId] ?? (routeGoods.find((g) => g.id === lineId)?.quantity || '').toString()
  const shown = routeGoods.filter((g) => !cur.removed.includes(g.id))
  const hidden = routeGoods.filter((g) => cur.removed.includes(g.id))

  // The additional quantity is optional: empty is fine, anything typed must be a number above 0.
  const extOf = (lineId: string) => cur.ext[lineId] ?? ''
  const lines = shown.map((g) => ({ key: g.id, name: g.name, unit: g.unitTxt, price: g.price, quantity: qty(qtyOf(g.id)), ext: extOf(g.id).trim() ? qty(extOf(g.id)) : undefined }))
  const complete = lines.length > 0 && lines.every((l) => l.quantity)
  const total = complete ? lines.reduce((a, l) => a + l.quantity!, 0) : null
  const amount = complete ? lines.reduce((a, l) => a + Math.round(l.quantity! * l.price * 100) / 100, 0) : null

  /* ------------------------------ Waybill ------------------------------ */

  // What the route (then the settings) says; anything the user changed overrides it.
  const base = toWaybillForm(waybillDefaults(d.rs, route))
  const [wb, setWb] = useState<Partial<WaybillForm>>(seed?.waybill ?? {})
  const w: WaybillForm = { ...base, ...wb }
  const setW = <K extends keyof WaybillForm>(k: K, v: WaybillForm[K]) => {
    setWb((x) => ({ ...x, [k]: v }))
    clear(k)
  }
  const internal = w.type === 1
  const still = noTransport(w.type)
  const buyerTin = w.buyerTin.trim()
  // Any number: RS.ge's name when it knows it (not editable), else whatever the user types.
  const buyer = useTinName(internal ? '' : buyerTin, true, true)
  const buyerShown = buyer.state === 'ok' ? buyer.name : w.buyerName || (buyerTin === base.buyerTin ? waybillDefaults(d.rs, route).buyerName : '')
  const start = routeAddresses(d.carriers, route)
  const beginIso = w.begin === 'later' ? fromTbilisiInput(w.beginAt) : ''
  const nowInput = toTbilisiInput()
  const maxInput = toTbilisiInput(new Date(Date.now() + MAX_DEFER_MS - 10 * 60_000))

  // Operators don't see the service user, so only check what they can see; the server checks the rest.
  const rsNotReady = rsMissing(d.rs, { hasCreds: true }).length > 0

  const submit = async (e: FormEvent | null, draft: boolean) => {
    e?.preventDefault()
    const err: Record<string, string> = {}
    if (!carrier) err.carrierId = 'აირჩიე კარიერი'
    else if (!route) err.routeId = 'აირჩიე მარშრუტი'
    if (!still) {
      if (!form.driverId) err.driverId = 'აირჩიე მძღოლი'
      if (!form.truckId) err.truckId = 'აირჩიე მანქანა'
    }
    if (route && !routeGoods.length) err.routeId = 'ამ მარშრუტს პროდუქტები არ აქვს — მიმართე ადმინისტრატორს'
    else if (route && !lines.length) err.items = 'რეისზე მინიმუმ ერთი პროდუქტი უნდა იყოს'
    for (const l of lines) {
      if (!l.quantity) err[`${l.key}.quantity`] = 'რაოდენობა: შეიყვანე 0-ზე მეტი'
      else if (l.ext === null) err[`${l.key}.quantity`] = 'დამატებითი რაოდენობა: შეიყვანე 0-ზე მეტი ან დატოვე ცარიელი'
    }
    if (!internal) {
      if (!buyerTin) err.buyerTin = 'ამ ტიპის ზედნადებს მყიდველი სჭირდება'
      else if (buyerTin === d.rs.sellerTin) err.buyerTin = 'მყიდველი გამყიდველს ემთხვევა — აირჩიე „შიდა გადაზიდვა“'
      else if (buyer.state === 'loading') err.buyerTin = 'დაელოდე, მოწმდება RS.ge-ზე'
      else if (buyer.state === 'error') err.buyerTin = buyer.message
      else if (buyer.state === 'missing' && !w.buyerName.trim()) err.buyerName = 'RS.ge-ზე ვერ მოიძებნა — ჩაწერე დასახელება'
    }
    if (w.begin === 'later' && !correcting) {
      const t = Date.parse(beginIso)
      if (!beginIso) err.beginAt = 'აირჩიე დრო'
      else if (t < Date.now()) err.beginAt = 'დრო უკვე გავიდა'
      else if (t > Date.now() + MAX_DEFER_MS - 5 * 60_000) err.beginAt = 'მაქსიმუმ 3 დღით ადრე'
    }
    if (w.transportCost.trim() && !(Number(w.transportCost.replace(',', '.')) >= 0)) err.transportCost = 'შეიყვანე 0 ან მეტი'
    setErrors(err)
    if (err.transportCost) setMore(true)
    if (Object.keys(err).length || !carrier || !route) return
    const items: NewShipmentItem[] = lines.map((l) => ({ lineId: l.key, quantity: l.quantity!, ...(l.ext && { quantityExt: l.ext }) }))
    const input: NewShipmentInput = {
      carrierId: carrier.id,
      routeId: route.id,
      driverId: still ? '' : form.driverId,
      truckId: still ? '' : form.truckId,
      items,
      waybill: {
        type: w.type,
        buyerTin: internal ? '' : buyerTin,
        buyerName: buyer.state === 'ok' ? buyer.name : w.buyerName.trim(),
        ...(!correcting && { beginAt: beginIso }),
        transportCost: Number(w.transportCost.replace(',', '.') || 0),
        tranCostPayer: Number(w.tranCostPayer) as 1 | 2,
        receptionInfo: w.receptionInfo.trim(),
        receiverInfo: w.receiverInfo.trim(),
        comment: w.comment.trim(),
      },
      ...(draft && { draft }),
    }
    setBusy(draft ? 'draft' : 'send')
    try {
      if (editing) {
        await shipments.edit(editing.id, input)
        toast('success', correcting ? 'ზედნადები დაკორექტირდა RS.ge-ზე' : editing.status === 'saved' ? 'RS.ge-ზე შენახული ზედნადები განახლდა' : 'რეისი შეიცვალა')
        nav(`/shipments/${editing.id}`)
      } else {
        const id = await shipments.create(input, user)
        toast('info', draft ? 'ზედნადები ინახება RS.ge-ზე…' : 'ზედნადები იტვირთება RS.ge-ზე…')
        nav(`/shipments/${id}`)
      }
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy('')
    }
  }

  const title = editing ? (correcting ? 'ზედნადების კორექტირება' : 'რეისის რედაქტირება') : 'ახალი რეისი'
  const subtitle = editing
    ? correcting
      ? `№${editing.waybillNumber} — ცვლილება RS.ge-ზე კორექტირებად აისახება.`
      : editing.status === 'saved'
        ? 'ზედნადები RS.ge-ზე შენახულია და ჯერ არ არის გააქტიურებული.'
        : 'ცვლილების შემდეგ დააჭირე „ხელახლა ცდას“.'
    : copiedFrom
      ? `ასლი რეისიდან ${copiedFrom.waybillNumber ? `№${copiedFrom.waybillNumber}` : formatDateTime(copiedFrom.createdAt)} — შეამოწმე და ატვირთე.`
      : 'აირჩიე მარშრუტი, პროდუქტები, მძღოლი და მანქანა, შემდეგ ატვირთე ზედნადები RS.ge-ზე.'

  return (
    <>
      {editing && (
        <Link to={`/shipments/${editing.id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
          <ArrowLeft className="size-4" /> რეისი
        </Link>
      )}
      <PageHeader title={title} subtitle={subtitle} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form onSubmit={(e) => void submit(e, false)} className="space-y-4" noValidate>
          <Card className="space-y-5 p-5 sm:p-6">
            {carriers.length === 1 || editing ? (
              <div className="rounded-[10px] bg-fill px-4 py-3 text-sm">
                <span className="text-slate-500">კარიერი: </span>
                <span className="font-medium text-slate-900">{carrier?.name}</span>
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
              <Select value={route?.id ?? ''} onChange={set('routeId')} placeholder={carrier ? 'აირჩიე მარშრუტი…' : 'ჯერ აირჩიე კარიერი'} invalid={!!errors.routeId} disabled={!routes.length} searchable={routes.length > 8}>
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
                                  clear(`${g.id}.quantity`)
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
                                  clear(`${g.id}.quantity`)
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
                                clear(`${g.id}.quantity`)
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
                          clear('items')
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

            {still ? (
              <div className="rounded-[10px] bg-fill px-4 py-3 text-sm text-slate-600">ტრანსპორტირების გარეშე: მძღოლი და მანქანა არ მიეთითება, ტვირთი ბარდება {start.start || 'დაწყების მისამართზე'}.</div>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field label="მძღოლი" error={errors.driverId}>
                  <Select value={form.driverId} onChange={set('driverId')} placeholder="აირჩიე მძღოლი…" invalid={!!errors.driverId} searchable={active(d.drivers).length > 8}>
                    {d.drivers
                      .filter((x) => !x.deletedAt || x.id === editing?.driverId)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.firstName} {x.lastName}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="მანქანა" error={errors.truckId}>
                  <Select value={form.truckId} onChange={set('truckId')} placeholder="აირჩიე მანქანა…" invalid={!!errors.truckId} searchable={active(d.trucks).length > 8}>
                    {d.trucks
                      .filter((x) => !x.deletedAt || x.id === editing?.truckId)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.plateNumber} · {x.model}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
            )}
          </Card>

          {/* Waybill: type, buyer, start, extras — prefilled from the route and the RS.ge settings. */}
          <Card className="space-y-5 p-5 sm:p-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">ზედნადები</h3>
              <p className="text-xs text-slate-500">შევსებულია მარშრუტიდან და RS.ge-ს პარამეტრებიდან — საჭიროების შემთხვევაში შეცვალე ამ რეისისთვის.</p>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="ზედნადების ტიპი" hint={correcting ? 'აქტიურ ზედნადებზე ტიპი არ იცვლება' : WAYBILL_TYPES.find((t) => t.value === w.type)?.hint}>
                <Select value={String(w.type)} onChange={(e) => setW('type', Number(e.target.value) as WaybillType)} disabled={correcting}>
                  {WAYBILL_TYPES.map((t) => (
                    <option key={t.value} value={String(t.value)}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {internal ? (
                <Field label="მყიდველი">
                  <Fixed>{d.rs.sellerName ? `${d.rs.sellerName} (გამყიდველი)` : 'გამყიდველი'}</Fixed>
                </Field>
              ) : (
                <div>
                  <Field label="მყიდველის საიდენტიფიკაციო / პირადი ნომერი" error={errors.buyerTin}>
                    <Input value={w.buyerTin} className="font-mono" invalid={!!errors.buyerTin} onChange={(e) => setW('buyerTin', e.target.value)} />
                  </Field>
                  {!errors.buyerTin && buyer.state !== 'missing' && <LookupLine lookup={buyer.state === 'idle' && buyerShown ? { state: 'ok', name: buyerShown } : buyer} />}
                </div>
              )}
              {!internal && buyer.state === 'missing' && (
                <Field label="მყიდველის დასახელება" error={errors.buyerName} hint="RS.ge-ზე ვერ მოიძებნა — უცხოელი მყიდველის სახელი ჩაწერე ხელით">
                  <Input value={w.buyerName} invalid={!!errors.buyerName} onChange={(e) => setW('buyerName', e.target.value)} />
                </Field>
              )}
            </div>

            {!correcting && (
              <div>
                <p className="mb-1.5 ml-1 text-[13px] text-slate-500">ტრანსპორტირების დაწყება</p>
                <div className="flex flex-wrap items-start gap-3">
                  <Segmented
                    value={w.begin}
                    onChange={(v) => {
                      setW('begin', v)
                      if (v === 'later' && !w.beginAt) setW('beginAt', toTbilisiInput(new Date(Date.now() + 3600_000)))
                    }}
                    options={[
                      { value: 'now', label: 'გააქტიურებისას' },
                      { value: 'later', label: 'დაგეგმილი' },
                    ]}
                  />
                  {w.begin === 'later' && (
                    <div className="min-w-0 flex-1 sm:max-w-64">
                      <Input type="datetime-local" value={w.beginAt} min={nowInput} max={maxInput} invalid={!!errors.beginAt} onChange={(e) => setW('beginAt', e.target.value)} />
                      <p className={cx('mt-1 ml-1 text-xs', errors.beginAt ? 'text-rose-600' : 'text-slate-500')}>{errors.beginAt || 'საქართველოს დროით · მაქსიმუმ 3 დღით ადრე'}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div>
              <button type="button" onClick={() => setMore((x) => !x)} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600">
                <ChevronDown className={cx('size-4 transition-transform', more && 'rotate-180')} />
                დამატებითი ველები
                {!more && <span className="font-normal text-slate-400"> · ტრანსპორტირების ღირებულება, მიმწოდებელი, მიმღები, კომენტარი</span>}
              </button>
              {more && (
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {!still && (
                    <>
                      <Field label="ტრანსპორტირების ღირებულება (₾)" error={errors.transportCost}>
                        <Input type="text" inputMode="decimal" value={w.transportCost} placeholder="0" invalid={!!errors.transportCost} onChange={(e) => setW('transportCost', e.target.value)} />
                      </Field>
                      <Field label="ტრანსპორტირების ხარჯს იხდის">
                        <Select value={w.tranCostPayer} onChange={(e) => setW('tranCostPayer', e.target.value as '1' | '2')}>
                          <option value="2">გამყიდველი</option>
                          <option value="1">მყიდველი</option>
                        </Select>
                      </Field>
                    </>
                  )}
                  <Field label="მიმწოდებლის ინფორმაცია">
                    <Input value={w.receptionInfo} maxLength={250} onChange={(e) => setW('receptionInfo', e.target.value)} />
                  </Field>
                  <Field label="მიმღების ინფორმაცია">
                    <Input value={w.receiverInfo} maxLength={250} onChange={(e) => setW('receiverInfo', e.target.value)} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="კომენტარი" hint="მისაბმელის ნომერი კომენტარს ავტომატურად ემატება.">
                      <Input value={w.comment} maxLength={250} onChange={(e) => setW('comment', e.target.value)} />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {rsNotReady && <div className="rounded-[10px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">RS.ge პარამეტრები (ტრანსპორტი) არ არის შევსებული — მიმართე ადმინისტრატორს.</div>}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => nav(-1)}>
              გაუქმება
            </Button>
            {!editing && (
              <Button type="button" variant="secondary" size="lg" loading={busy === 'draft'} disabled={!!busy} icon={<Save className="size-5" />} onClick={() => void submit(null, true)}>
                მხოლოდ შენახვა
              </Button>
            )}
            <Button type="submit" size="lg" loading={busy === 'send'} disabled={!!busy} icon={editing ? <CheckCircle2 className="size-5" /> : w.begin === 'later' ? <CalendarClock className="size-5" /> : <FileCheck2 className="size-5" />}>
              {editing ? (correcting ? 'კორექტირება RS.ge-ზე' : 'შენახვა') : w.begin === 'later' ? 'ატვირთვა (დაგეგმილი)' : 'ზედნადების ატვირთვა'}
            </Button>
          </div>
        </form>

        {/* Summary */}
        <div className="space-y-4">
          <Card className="p-5 lg:sticky lg:top-4">
            <h3 className="text-sm font-semibold text-slate-900">შეჯამება</h3>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row k="ტიპი" v={waybillTypeLabel(w.type)} />
              <Row k="მყიდველი" v={internal ? d.rs.sellerName || 'გამყიდველი' : buyerShown || buyerTin || undefined} />
              <Row k="მარშრუტი" v={route ? (still ? start.start : routeLabel(d.carriers, route)) : undefined} />
              {!still && (
                <>
                  <Row k="მძღოლი" v={driver ? `${driver.firstName} ${driver.lastName}` : undefined} />
                  <Row k="მანქანა" v={truck ? `${truck.plateNumber}${truck.trailerNumber ? ` · ${truck.trailerNumber}` : ''}` : undefined} mono />
                </>
              )}
              {lines.length ? lines.map((l) => <Row key={l.key} k={l.name || 'პროდუქტი'} v={l.quantity ? `${formatNumber(l.quantity, 3)}${l.unit ? ` ${l.unit}` : ''}` : undefined} />) : <Row k="პროდუქტი" />}
              {lines.length > 1 && <Row k="სულ" v={total ? formatNumber(total, 3) : undefined} />}
              <Row k="თანხა" v={amount != null ? `${amount.toFixed(2)} ₾` : undefined} />
              {!correcting && <Row k="დაწყება" v={w.begin === 'later' ? (beginIso ? formatDateTime(beginIso) : undefined) : 'გააქტიურებისას'} />}
            </dl>
          </Card>
          {!editing && (
            <div className="flex gap-3 rounded-2xl bg-brand-50 p-4 text-sm text-brand-900 ring-1 ring-brand-100">
              <Info className="mt-0.5 size-4 shrink-0 text-brand-500" />
              <div className="space-y-1 text-brand-800">
                <p>
                  <b className="font-medium text-brand-900">ატვირთვა</b> — RS.ge-ზე შეინახება, გააქტიურდება და მძღოლს SMS-ით გაეგზავნება ნომერი.
                </p>
                <p>
                  <b className="font-medium text-brand-900">მხოლოდ შენახვა</b> — RS.ge-ზე დარჩება შენახულ მდგომარეობაში; მოგვიანებით შეცვლი ან გააქტიურებ.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Fixed({ children }: { children: ReactNode }) {
  return <div className="flex h-11 items-center gap-1.5 truncate rounded-[10px] px-3 text-[16px] text-slate-900 ring-1 ring-slate-500/15 ring-inset sm:text-[15px]">{children}</div>
}

function Row({ k, v, mono }: { k: string; v?: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{k}</dt>
      <dd className={`min-w-0 text-right [overflow-wrap:anywhere] ${v ? 'text-slate-900' : 'text-slate-300'} ${mono ? 'font-mono text-[13px]' : ''}`}>{v ?? '—'}</dd>
    </div>
  )
}
