import { ArrowLeft, Building2, CalendarClock, CheckCircle2, ChevronDown, CircleDot, FileCheck2, Info, Loader2, MapPin, PencilLine, Save, Truck as TruckIcon, UserRound, Warehouse } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { rsPending, shipments, usableCarriers, useRsLoad, type NewShipmentInput } from '../api'
import { Button, Card, EmptyState, Field, Input, PageHeader, Segmented, Select } from '../components/ui'
import { OptionRow } from '../components/pickers'
import { WAYBILL_TYPE_ICON } from '../components/icons'
import { LookupLine, TIN_RE, useTinName } from '../components/TinLookup'
import { blankGood, checkGoods, draftLine, fromDrafts, ShipmentGoodsEditor, toDraft, type GoodDraft } from '../components/ShipmentGoods'
import { cx, formatDateTime, formatNumber, fromTbilisiInput, toTbilisiInput } from '../lib/util'
import { routeAddresses, routeLabel, routeUsable, canUseCarrier } from '../lib/route'
import { editable, MAX_DEFER_MS, noTransport, RS_TRANS_OTHER, rsMissing, transTypes, waybillDefaults, WAYBILL_TYPES, waybillTypeLabel } from '../lib/rs'
import { useToast } from '../components/toast'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { Database, Shipment, ShipmentWaybill, WaybillType } from '../types'

/** Waybill fields as typed. */
type WaybillForm = {
  type: WaybillType
  buyerTin: string
  buyerName: string
  begin: 'now' | 'later'
  /** datetime-local, Georgian time. */
  beginAt: string
  transId: string
  transTxt: string
  transporterTin: string
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
  transId: String(w.transId),
  transTxt: w.transTxt,
  transporterTin: w.transporterTin,
  transportCost: w.transportCost ? String(w.transportCost) : '',
  tranCostPayer: String(w.tranCostPayer) as '1' | '2',
  receptionInfo: w.receptionInfo,
  receiverInfo: w.receiverInfo,
  comment: w.comment,
})

/** Where the form starts: empty, a copy of another shipment (`?from=`), or the shipment being edited. */
type Seed = { carrierId: string; routeId: string; driverId: string; truckId: string; goods: GoodDraft[]; waybill?: Partial<WaybillForm> }

function seedFrom(s: Shipment, keepBegin: boolean): Seed {
  const w = s.waybill && toWaybillForm(s.waybill)
  return {
    carrierId: s.carrierId,
    routeId: s.routeId,
    driverId: s.driverId,
    truckId: s.truckId,
    goods: s.items.map(toDraft),
    ...(w && { waybill: keepBegin ? w : { ...w, begin: 'now', beginAt: '' } }),
  }
}

/** A new shipment's goods: those of the last shipment on the route whose goods are known here, else one empty line. */
function lastGoods(d: Database, routeId: string): GoodDraft[] {
  const last = [...d.shipments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((s) => s.routeId === routeId && s.items.length)
  return last ? last.items.map(toDraft) : [blankGood(d)]
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
  return <ShipmentForm key={from?.id ?? 'new'} seed={from ? seedFrom(from, false) : undefined} copiedFrom={from} />
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
  return <ShipmentForm key={s.id} seed={seedFrom(s, true)} editing={s} />
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
  // The goods: until the operator touches them, those of the last shipment on the route.
  const [typedGoods, setGoods] = useState<GoodDraft[] | null>(seed?.goods ?? null)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keys must stay put while the route is the same
  const routeGoods = useMemo(() => (route ? lastGoods(d, route.id) : [blankGood(d)]), [route?.id])
  const goods = typedGoods ?? routeGoods
  const lines = goods.map((g) => draftLine(d, g))
  const complete = lines.length > 0 && lines.every((l) => l.quantity && l.price != null)
  const total = complete ? lines.reduce((a, l) => a + l.quantity!, 0) : null
  const amount = complete ? lines.reduce((a, l) => a + Math.round(l.quantity! * l.price! * 100) / 100, 0) : null

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
  const transporterTin = w.transporterTin.trim()
  const transporter = useTinName(still ? '' : transporterTin, true)
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
    Object.assign(err, checkGoods(goods))
    // Error keys name the lines: they stay put from now on.
    setGoods(goods)
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
    if (!still) {
      if (w.transportCost.trim() && !(Number(w.transportCost.replace(',', '.')) >= 0)) err.transportCost = 'შეიყვანე 0 ან მეტი'
      if (Number(w.transId) === RS_TRANS_OTHER && !w.transTxt.trim()) err.transTxt = 'სავალდებულო ველი'
      if (transporterTin && !TIN_RE.test(transporterTin)) err.transporterTin = '9 ან 11 ციფრი'
      else if (transporter.state === 'error') err.transporterTin = transporter.message
    }
    setErrors(err)
    if (err.transportCost || err.transTxt || err.transporterTin) setMore(true)
    if (Object.keys(err).length || !carrier || !route) return
    const items = fromDrafts(d, goods)
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
        transId: Number(w.transId),
        transTxt: Number(w.transId) === RS_TRANS_OTHER ? w.transTxt.trim() : '',
        transporterTin: still ? '' : transporterTin,
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
                <Select value={carrier?.id ?? ''} onChange={set('carrierId')} placeholder="აირჩიე კარიერი…" invalid={!!errors.carrierId} disabled={!carriers.length} searchable rich>
                  {carriers.map((c) => (
                    <option key={c.id} value={c.id} label={c.name} data-search={c.startAddress}>
                      <OptionRow icon={<Building2 />} title={c.name} sub={c.startAddress} />
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field
              label="მარშრუტი"
              error={errors.routeId}
              hint={carrier && !routes.length ? 'ამ კარიერს მარშრუტი ჯერ არ აქვს — სთხოვე ადმინისტრატორს დამატება.' : undefined}
            >
              <Select
                value={route?.id ?? ''}
                onChange={set('routeId')}
                placeholder={carrier ? 'აირჩიე მარშრუტი…' : 'ჯერ აირჩიე კარიერი'}
                invalid={!!errors.routeId}
                disabled={!routes.length}
                searchable
                rich
                header={
                  // Every route of a carrier starts at the carrier's address: said once, not on each row.
                  <span className="flex items-center gap-1.5 px-0.5 text-[13px] text-slate-500 sm:text-[12px]">
                    <CircleDot className="size-3.5 shrink-0" strokeWidth={2.25} />
                    <span className="shrink-0">დაწყება</span>
                    <span className="min-w-0 truncate font-medium text-slate-700">{carrier?.startAddress || '—'}</span>
                  </span>
                }
              >
                {routes.map((x) => {
                  const buyer = x.buyerName || x.buyerTin
                  return (
                    <option key={x.id} value={x.id} label={`${routeLabel(d.carriers, x)}${buyer ? ` · ${buyer}` : ''}`} data-search={[x.buyerTin, buyer ? '' : 'შიდა გადაზიდვა'].join(' ')}>
                      <OptionRow
                        icon={buyer ? <MapPin /> : <Warehouse />}
                        title={routeAddresses(d.carriers, x).end}
                        sub={
                          buyer ? (
                            <>
                              {x.buyerName && <span className="min-w-0 truncate">{x.buyerName}</span>}
                              {x.buyerTin && <span className="shrink-0 tabular-nums">{x.buyerTin}</span>}
                            </>
                          ) : (
                            'შიდა გადაზიდვა'
                          )
                        }
                      />
                    </option>
                  )
                })}
              </Select>
            </Field>

            <ShipmentGoodsEditor d={d} goods={goods} onChange={setGoods} errors={errors} onClearError={(k) => clear(k)} />

            {still ? (
              <div className="rounded-[10px] bg-fill px-4 py-3 text-sm text-slate-600">ტრანსპორტირების გარეშე: მძღოლი და მანქანა არ მიეთითება, ტვირთი ბარდება {start.start || 'დაწყების მისამართზე'}.</div>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field label="მძღოლი" error={errors.driverId}>
                  <Select value={form.driverId} onChange={set('driverId')} placeholder="აირჩიე მძღოლი…" invalid={!!errors.driverId} searchable rich>
                    {d.drivers
                      .filter((x) => !x.deletedAt || x.id === editing?.driverId)
                      .map((x) => {
                        const name = `${x.firstName} ${x.lastName}`.trim()
                        return (
                          <option key={x.id} value={x.id} label={name} data-search={`${x.personalId} ${x.phone}`}>
                            <OptionRow icon={<UserRound />} title={name} sub={[x.phone, x.personalId].filter(Boolean).join(' · ')} />
                          </option>
                        )
                      })}
                  </Select>
                </Field>
                <Field label="მანქანა" error={errors.truckId}>
                  <Select value={form.truckId} onChange={set('truckId')} placeholder="აირჩიე მანქანა…" invalid={!!errors.truckId} searchable rich>
                    {d.trucks
                      .filter((x) => !x.deletedAt || x.id === editing?.truckId)
                      .map((x) => (
                        <option key={x.id} value={x.id} label={[x.plateNumber, x.model].filter(Boolean).join(' · ')} data-search={x.trailerNumber}>
                          <OptionRow icon={<TruckIcon />} title={x.plateNumber} sub={[x.model, x.trailerNumber && `მისაბმელი ${x.trailerNumber}`].filter(Boolean).join(' · ')} />
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
            )}
          </Card>

          {/* Waybill: type, buyer, start, extras — prefilled from the route and the RS.ge settings. */}
          <Card className="space-y-5 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">ზედნადები</h2>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="ზედნადების ტიპი">
                <Select value={String(w.type)} onChange={(e) => setW('type', Number(e.target.value) as WaybillType)} disabled={correcting} rich>
                  {WAYBILL_TYPES.map((t) => (
                    <option key={t.value} value={String(t.value)} label={t.label}>
                      <OptionRow icon={WAYBILL_TYPE_ICON[t.value]} title={t.label} sub={t.hint} />
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
                <Field label="მყიდველის დასახელება" error={errors.buyerName}>
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
                {!more && <span className="hidden font-normal text-slate-400 sm:inline"> · {still ? 'მიმწოდებელი, მიმღები, კომენტარი' : 'ტრანსპორტი, ღირებულება, კომენტარი…'}</span>}
              </button>
              {more && (
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {!still && (
                    <>
                      <Field label="ტრანსპორტის ტიპი">
                        <Select value={w.transId} onChange={(e) => setW('transId', e.target.value)}>
                          {transTypes(d.rs).map((t) => (
                            <option key={t.id} value={String(t.id)}>
                              {t.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {Number(w.transId) === RS_TRANS_OTHER ? (
                        <Field label="ტრანსპორტის ტიპის დასახელება" error={errors.transTxt}>
                          <Input value={w.transTxt} maxLength={250} invalid={!!errors.transTxt} onChange={(e) => setW('transTxt', e.target.value)} />
                        </Field>
                      ) : (
                        <div className="hidden sm:block" />
                      )}
                      <div className="sm:col-span-2">
                        <Field label="გადამზიდავი კომპანიის ს/ნ (არასავალდებულო)" error={errors.transporterTin}>
                          <Input value={w.transporterTin} inputMode="numeric" className="font-mono" invalid={!!errors.transporterTin} onChange={(e) => setW('transporterTin', e.target.value)} />
                        </Field>
                        {!errors.transporterTin && <LookupLine lookup={transporter} />}
                      </div>
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
                    <Field label="კომენტარი">
                      <Input value={w.comment} maxLength={250} onChange={(e) => setW('comment', e.target.value)} />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {rsNotReady && <div className="rounded-[10px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">RS.ge არ არის დაკავშირებული — მიმართე ადმინისტრატორს.</div>}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" size="lg" onClick={() => nav(-1)}>
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
            <h2 className="text-sm font-semibold text-slate-900">შეჯამება</h2>
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
