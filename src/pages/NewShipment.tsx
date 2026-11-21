import { ArrowLeft, CheckCircle2, FileCheck2, Info, Loader2, PencilLine } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { rsPending, shipments, usableCarriers, useRsLoad, type NewShipmentInput } from '../api'
import { Button, Card, EmptyState, Field, InfoRow, PageHeader, Select } from '../components/ui'
import { OptionRow } from '../components/pickers'
import { formatDateTime, formatNumber, formatMoney } from '../lib/util'
import { canUseCarrier, goodsText, routeAddresses, routeLabel, routeUsable } from '../lib/route'
import { editable, itemAmount, rsMissing } from '../lib/rs'
import { useToast } from '../components/toast'
import { useDb } from '../api/store'
import { useUser } from '../session'
import type { CarrierRoute, Database, Shipment } from '../types'

/** Where the form starts: empty, a copy of another shipment (`?from=`), or the shipment being edited. */
type Seed = { routeId: string; driverId: string; truckId: string }

const seedFrom = (s: Shipment): Seed => ({ routeId: s.routeId, driverId: s.driverId, truckId: s.truckId })

/** Waiting for RS.ge's copy of a waybill: its goods are read from RS.ge, not stored here. */
function ReadingFromRs({ s }: { s: Shipment }) {
  useRsLoad([s])
  return <EmptyState icon={<Loader2 className="size-6 animate-spin" />} title="ზედნადები იკითხება RS.ge-დან…" text="პროდუქტები RS.ge-ზეა — ფორმა გაიხსნება, როგორც კი წაიკითხება." action={<Link to={`/shipments/${s.id}`} className="text-sm font-medium text-brand-600">რეისზე დაბრუნება</Link>} />
}

export function NewShipment() {
  const d = useDb()
  const user = useUser()
  const [params] = useSearchParams()
  const from = d.shipments.find((x) => x.id === params.get('from') && canUseCarrier(user, x.carrierId))
  // A copy of another shipment: same route, driver and truck; a new waybill with the route's goods.
  return <ShipmentForm key={from?.id ?? 'new'} seed={from ? seedFrom(from) : undefined} copiedFrom={from} />
}

export function EditShipment() {
  const { id } = useParams()
  const d = useDb()
  const user = useUser()
  const s = d.shipments.find((x) => x.id === id)
  if (!s || !canUseCarrier(user, s.carrierId) || user.role === 'report') {
    return <EmptyState icon={<PencilLine className="size-6" />} title="რეისი ვერ მოიძებნა" action={<Link to="/shipments" className="text-sm font-medium text-brand-600">რეისებზე დაბრუნება</Link>} />
  }
  // The goods it keeps on the same route are RS.ge's: shown once read.
  if (rsPending(s) && !s.items.length) return <ReadingFromRs s={s} />
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
  return <ShipmentForm key={s.id} seed={seedFrom(s)} editing={s} />
}

/**
 * The operator picks the route, the driver and the truck; everything else on the waybill (goods,
 * quantities, transport details) is the route's, set by the admin, and the waybill is შიდა გადაზიდვა.
 */
function ShipmentForm({ seed, editing, copiedFrom }: { seed?: Seed; editing?: Shipment; copiedFrom?: Shipment }) {
  const user = useUser()
  const d = useDb()
  const nav = useNavigate()
  const toast = useToast()
  const carriers = usableCarriers(d, user)
  const [form, setForm] = useState<Seed>(seed ?? { routeId: '', driverId: '', truckId: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  // Active on RS.ge: a correction.
  const correcting = editing?.status === 'uploaded'

  // Every route of the user's carriers (the one being edited stays even if it can't be picked anew).
  const routes = d.routes.filter((x) => carriers.some((c) => c.id === x.carrierId) && (routeUsable(d.carriers, x) || x.id === editing?.routeId))
  // With a single route there is nothing to choose: it is preselected.
  const route = routes.find((x) => x.id === form.routeId) ?? (routes.length === 1 ? routes[0] : undefined)
  const set = (k: keyof Seed) => (e: { target: { value: string } }) => {
    const v = e.target.value
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }

  // A waybill on RS.ge keeps its goods and transport details while the route stays the same; otherwise they are the route's.
  const kept = !!editing?.rsWaybillId && route?.id === editing.routeId && editing.items.length > 0
  const goods = kept ? editing!.items : (route?.goods ?? [])
  const driver = d.drivers.find((r) => r.id === form.driverId)
  const truck = d.trucks.find((r) => r.id === form.truckId)
  const total = goods.reduce((a, g) => a + g.quantity, 0)
  const amount = goods.reduce((a, g) => a + itemAmount(g), 0)

  // Operators don't see the service user, so only check what they can see; the server checks the rest.
  const rsNotReady = rsMissing(d.rs, { hasCreds: true }).length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!route) err.routeId = 'აირჩიე მარშრუტი'
    if (!form.driverId) err.driverId = 'აირჩიე მძღოლი'
    if (!form.truckId) err.truckId = 'აირჩიე მანქანა'
    setErrors(err)
    if (Object.keys(err).length || !route) return
    const input: NewShipmentInput = { routeId: route.id, driverId: form.driverId, truckId: form.truckId }
    setBusy(true)
    try {
      if (editing) {
        await shipments.edit(editing.id, input)
        toast('success', correcting ? 'ზედნადები დაკორექტირდა RS.ge-ზე' : editing.status === 'saved' ? 'RS.ge-ზე შენახული ზედნადები განახლდა' : 'რეისი შეიცვალა')
        nav(`/shipments/${editing.id}`)
      } else {
        const id = await shipments.create(input, user)
        toast('info', 'ზედნადები იტვირთება RS.ge-ზე…')
        nav(`/shipments/${id}`)
      }
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(false)
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
      : 'აირჩიე მარშრუტი, მძღოლი და მანქანა, შემდეგ ატვირთე ზედნადები RS.ge-ზე.'

  return (
    <>
      {editing && (
        <Link to={`/shipments/${editing.id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
          <ArrowLeft className="size-4" /> რეისი
        </Link>
      )}
      <PageHeader title={title} subtitle={subtitle} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          <Card className="@container space-y-5 p-5 sm:p-6">
            <Field
              label="მარშრუტი"
              error={errors.routeId}
              hint={
                routes.length
                  ? undefined
                  : !carriers.length && user.role === 'operator'
                    ? 'შენ არცერთი კარიერი არ გაქვს მინიჭებული — მიმართე ადმინისტრატორს.'
                    : user.role === 'admin'
                      ? 'მარშრუტი ჯერ არ არის — დაამატე ცნობარებში (პროდუქტებით).'
                      : 'მარშრუტი ჯერ არ არის — სთხოვე ადმინისტრატორს დამატება.'
              }
            >
              <Select
                value={route?.id ?? ''}
                onChange={set('routeId')}
                placeholder="აირჩიე მარშრუტი…"
                sheetTitle="მარშრუტი"
                invalid={!!errors.routeId}
                disabled={!routes.length}
                searchable
                rich
                cards
              >
                {routes.map((x) => {
                  const { carrier } = routeAddresses(d.carriers, x)
                  const label = routePickLabel(d, x)
                  return (
                    <option key={x.id} value={x.id} label={label} data-search={[carrier?.name, carrier?.startAddress, x.comment, goodsText(x.goods)].join(' ')}>
                      <RouteOption d={d} route={x} />
                    </option>
                  )
                })}
              </Select>
            </Field>

            <div className="grid grid-cols-1 gap-5 @md:grid-cols-2">
              <Field label="მძღოლი" error={errors.driverId}>
                <Select
                  value={form.driverId}
                  onChange={set('driverId')}
                  placeholder="აირჩიე მძღოლი…"
                  sheetTitle="მძღოლი"
                  invalid={!!errors.driverId}
                  searchable
                  rich
                >
                  {d.drivers
                    .filter((x) => !x.deletedAt || x.id === editing?.driverId)
                    .map((x) => {
                      const name = `${x.firstName} ${x.lastName}`.trim()
                      return (
                        <option key={x.id} value={x.id} label={name} data-search={`${x.personalId} ${x.phone}`}>
                          <OptionRow title={name} sub={[x.phone, x.personalId].filter(Boolean).join(' · ')} />
                        </option>
                      )
                    })}
                </Select>
              </Field>
              <Field label="მანქანა" error={errors.truckId}>
                <Select
                  value={form.truckId}
                  onChange={set('truckId')}
                  placeholder="აირჩიე მანქანა…"
                  sheetTitle="მანქანა"
                  invalid={!!errors.truckId}
                  searchable
                  rich
                >
                  {d.trucks
                    .filter((x) => !x.deletedAt || x.id === editing?.truckId)
                    .map((x) => (
                      <option key={x.id} value={x.id} label={[x.plateNumber, x.model].filter(Boolean).join(' · ')} data-search={x.trailerNumber}>
                        <OptionRow title={x.plateNumber} sub={[x.model, x.trailerNumber && `მისაბმელი ${x.trailerNumber}`].filter(Boolean).join(' · ')} />
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
          </Card>

          {rsNotReady && <div className="rounded-[10px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">RS.ge არ არის დაკავშირებული — მიმართე ადმინისტრატორს.</div>}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" size="lg" onClick={() => nav(-1)}>
              გაუქმება
            </Button>
            <Button type="submit" size="lg" loading={busy} disabled={busy} icon={editing ? <CheckCircle2 className="size-5" /> : <FileCheck2 className="size-5" />}>
              {editing ? (correcting ? 'კორექტირება RS.ge-ზე' : 'შენახვა') : 'ზედნადების ატვირთვა'}
            </Button>
          </div>
        </form>

        {/* Summary: what the waybill will say, the route's goods included. */}
        <div className="space-y-4">
          <Card className="p-5 xl:sticky xl:top-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">შეჯამება</h2>
            <dl className="divide-y divide-separator text-sm">
              <InfoRow k="ტიპი" v="შიდა გადაზიდვა" />
              <InfoRow k="მარშრუტი" v={route ? routePickLabel(d, route) : undefined} />
              <InfoRow k="მძღოლი" v={driver ? `${driver.firstName} ${driver.lastName}` : undefined} />
              <InfoRow k="მანქანა" v={truck ? `${truck.plateNumber}${truck.trailerNumber ? ` · ${truck.trailerNumber}` : ''}` : undefined} mono />
              {goods.length ? goods.map((g) => <InfoRow key={g.barCode} k={g.name} v={`${formatNumber(g.quantity, 3)}${g.unitTxt ? ` ${g.unitTxt}` : ''}`} />) : <InfoRow k="პროდუქტი" />}
              {goods.length > 1 && <InfoRow k="სულ" v={formatNumber(total, 3)} />}
              <InfoRow k="თანხა" v={goods.length ? `${formatMoney(amount)} ₾` : undefined} />
            </dl>
          </Card>
          {!editing && (
            <div className="flex gap-3 rounded-2xl bg-brand-50 p-4 text-sm text-brand-900 ring-1 ring-brand-100">
              <Info className="mt-0.5 size-4 shrink-0 text-brand-500" />
              <p className="text-brand-800">
                <b className="font-medium text-brand-900">ატვირთვა</b> —{' '}
                RS.ge-ზე შეინახება, გააქტიურდება და მძღოლს SMS-ით გაეგზავნება ნომერი.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** 'Carrier: Start → End': a route as the operator picks it. */
const routePickLabel = (d: Database, r: CarrierRoute) => {
  const carrier = d.carriers.find((c) => c.id === r.carrierId)
  return `${carrier?.name ? `${carrier.name}: ` : ''}${routeLabel(d.carriers, r)}`
}

/** A route in the picker: carrier and addresses on top, then everything its waybills will carry. */
function RouteOption({ d, route: r }: { d: Database; route: CarrierRoute }) {
  const { carrier, start, end } = routeAddresses(d.carriers, r)
  // Everything else the waybill carries, as label: value lines (the transport type is always საავტომობილო).
  const details: [string, string][] = [
    ...(r.transportCost ? [['ტრანსპორტირების ღირებულება', `${formatMoney(r.transportCost)} ₾`] as [string, string]] : []),
    ...(r.comment ? [['კომენტარი', r.comment] as [string, string]] : []),
  ]
  const goods = r.goods ?? []
  const muted = 'text-slate-500 group-data-hi:text-white/75'
  return (
    <span className="block min-w-0 py-0.5">
      {/* Carrier: start → end */}
      <span className="block leading-snug font-medium [overflow-wrap:anywhere]">
        {carrier?.name && <span className="font-semibold text-brand-600 group-data-hi:text-white">{carrier.name}: </span>}
        {start || '—'}
        <span className={`mx-1 ${muted}`}>→</span>
        {end || '—'}
      </span>

      {/* Goods (name: quantity × price = line total), the transport cost and the comment: one label: value line each. */}
      {(goods.length > 0 || details.length > 0) && (
        <span className="mt-1.5 block space-y-0.5 text-[13px] sm:mt-1 sm:space-y-0 sm:text-[12px]">
          {goods.map((g, i) => (
            <span key={i} className="block tabular-nums [overflow-wrap:anywhere]">
              <span className={muted}>{g.name}: </span>
              {formatNumber(g.quantity, 3)}
              {g.unitTxt ? ` ${g.unitTxt}` : ''}
              {g.price || g.amount != null ? ` × ${formatMoney(g.price)} ₾ = ${formatMoney(itemAmount(g))} ₾` : ''}
              {g.amount != null && <span className={muted}> (ხელით)</span>}
            </span>
          ))}
          {details.map(([k, v]) => (
            <span key={k} className="block [overflow-wrap:anywhere]">
              <span className={muted}>{k}: </span>
              {v}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
