import { AlertTriangle, Building2, CircleCheck, Loader2, Package, Pencil, Plus, Route, Search, Trash2, Truck, UserRound, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { products, refs, rsSettings, trucks, type RefCollection } from '../api'
import { Badge, Button, Card, ConfirmModal, DeleteButton, EmptyState, Field, FilterChips, Input, Modal, PageHeader, RefreshButton, Select } from '../components/ui'
import { useToast } from '../components/toast'
import { active, cx, fmtPhone, phoneKey, formatMoney } from '../lib/util'
import { useDb } from '../api/store'
import { roleLabel, useUser } from '../session'
import { goodsText, routeAddresses, routeLabel } from '../lib/route'
import { RS_UNIT_OTHER, RS_VAT_TYPES, rsUnits, tonneUnit } from '../lib/rs'
import type { CarrierRoute, Database } from '../types'
import { blankGood, checkGoods, fromDrafts, RouteGoodsEditor, toDraft, type GoodDraft } from '../components/RouteGoods'
import { MultiSelect, OptionRow } from '../components/pickers'

type Rec = Record<string, string | undefined> & { id: string }

interface FieldDef {
  key: string
  label: string
  type?: 'text' | 'tel' | 'email' | 'select'
  placeholder?: string
  /** A select's options; with an `icon` they are listed as rich rows (icon, title, `sub`) with a search field. */
  options?: (d: Database) => { value: string; label: string; icon?: ReactNode; sub?: string }[]
  /** Takes the full row of the form. */
  wide?: boolean
  validate?: (v: string, rec: Rec) => string | null
  optional?: boolean
  showIf?: (rec: Rec) => boolean
  mono?: boolean
  /** Value of a new record (default: '' or a select's first option). */
  initial?: (d: Database, r?: Rec) => string
  inputMode?: 'numeric' | 'decimal'
  /** Shown inside the field, after the value (a currency sign). */
  suffix?: string
  /** Shown below a route's goods, where RS.ge's form has it. */
  afterGoods?: boolean
}

const vFullName = (v: string) => (v.trim().split(/\s+/).length < 2 ? 'შეიყვანე სახელი და გვარი' : null)
const vAnyName = (v: string) => (v.trim() ? null : 'შეიყვანე სახელი')

interface TabDef {
  key: RefCollection
  label: string
  /** Genitive form, e.g. 'კარიერის' → 'კარიერის დამატება'. */
  singular: string
  icon: typeof Building2
  fields: FieldDef[]
  title: (r: Rec, d: Database) => string
  subtitle: (r: Rec, d: Database) => ReactNode
  columns: { label: string; render: (r: Rec, d: Database) => ReactNode }[]
}

const vPhone = (v: string) => (/^5\d{8}$/.test(phoneKey(v)) ? null : 'ფორმატი: 5XX XX XX XX')
/** '+995 575780323' → '575 78 03 23' */
/** Georgian citizens: 11-digit personal number. Foreigners: passport / ID number as issued. */
const vPid = (v: string, r: Rec) => (r.citizenship === 'foreign' || /^\d{11}$/.test(v.trim()) ? null : 'პირადი ნომერი უნდა იყოს 11 ციფრი')
const vEmail = (v: string) => (/^\S+@\S+\.\S+$/.test(v.trim()) ? null : 'ელ-ფოსტა არასწორია')
const vPlate = (v: string) => (/^[A-Z]{2}-\d{3}-[A-Z]{2}$/.test(v.trim().toUpperCase()) ? null : 'ფორმატი: AA-123-BB')

const vPrice = (v: string) => (Number(v.replace(',', '.')) >= 0 ? null : 'შეიყვანე 0 ან მეტი')
/** A product's unit price as RS.ge shows it: 10 → '10,00'. */
const fmtPrice = (v?: string) => formatMoney(Number(v) || 0)
const vatLabel = (v?: string) => RS_VAT_TYPES.find((x) => String(x.value) === (v || '0'))?.label ?? '—'

/** User records carry the operator's carrier ids. */
const carrierIdsOf = (r: Rec) => (r as unknown as { carrierIds?: string[] }).carrierIds ?? []

const carrierNames = (d: Database, r: Rec) =>
  carrierIdsOf(r)
    .map((id) => d.carriers.find((c) => c.id === id))
    .filter((c) => c && !c.deletedAt)
    .map((c) => c!.name)
    .join(', ') || '—'

const carrierName = (d: Database, id?: string) => d.carriers.find((c) => c.id === id)?.name ?? '—'
/** A route record resolved to its carrier and addresses. */
const routeOf = (d: Database, r: Rec) => routeAddresses(d.carriers, r as unknown as CarrierRoute)
/** A route record's goods lines. */
const goodsOf = (r: Rec) => (r as unknown as CarrierRoute).goods ?? []

const TABS: TabDef[] = [
  {
    key: 'carriers',
    label: 'კარიერები',
    singular: 'კარიერის',
    icon: Building2,
    fields: [
      { key: 'name', label: 'დასახელება', placeholder: 'კავკასია ლოჯისტიკი' },
      { key: 'startAddress', label: 'დაწყების მისამართი', placeholder: 'დატვირთვის პუნქტი' },
    ],
    title: (r) => r.name!,
    subtitle: (r) => r.startAddress,
    columns: [
      { label: 'სახელი', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
      { label: 'დაწყების მისამართი', render: (r) => r.startAddress },
    ],
  },
  {
    key: 'routes',
    label: 'მარშრუტები',
    singular: 'მარშრუტის',
    icon: Route,
    fields: [
      { key: 'carrierId', label: 'კარიერი', type: 'select', placeholder: 'აირჩიე კარიერი…', wide: true, options: (d) => active(d.carriers).map((c) => ({ value: c.id, label: c.name, icon: <Building2 />, sub: c.startAddress })) },
      { key: 'endAddress', label: 'დასრულების მისამართი', placeholder: 'ჩაბარების პუნქტი', wide: true },
      { key: 'scaleId', label: 'სასწორის ID', placeholder: 'SC-01', mono: true, wide: true },
      // The waybill's transport details, the same on every shipment of the route. The transport type is always საავტომობილო.
      { key: 'transportCost', label: 'ტრანსპორტირების ხარჯი', placeholder: '0.00', suffix: '₾', optional: true, validate: vPrice, inputMode: 'decimal', wide: true },
      { key: 'comment', label: 'კომენტარი', optional: true, wide: true, afterGoods: true },
    ],
    title: (r, d) => routeLabel(d.carriers, r as unknown as CarrierRoute),
    subtitle: (r, d) => [carrierName(d, r.carrierId), goodsText(goodsOf(r)) || 'პროდუქტები არ არის'].join(' · '),
    columns: [
      { label: 'კარიერი', render: (r, d) => <span className="font-medium text-slate-900">{carrierName(d, r.carrierId)}</span> },
      {
        label: 'მარშრუტი',
        render: (r, d) => (
          <span className="block min-w-40">
            {routeOf(d, r).start || '—'}
            <span className="block text-slate-500">→ {routeOf(d, r).end || '—'}</span>
          </span>
        ),
      },
      { label: 'სასწორის ID', render: (r) => <span className="font-mono text-[13px] whitespace-nowrap">{r.scaleId || '—'}</span> },
      {
        label: 'პროდუქტები',
        render: (r) => {
          const goods = goodsOf(r)
          // A route without goods can't be picked for a shipment until they are set.
          return goods.length ? <span className="block min-w-40">{goodsText(goods)}</span> : <Badge tone="amber">არ არის მითითებული</Badge>
        },
      },
    ],
  },
  {
    key: 'drivers',
    label: 'მძღოლები',
    singular: 'მძღოლის',
    icon: UserRound,
    fields: [
      // The number comes first: a Georgian one fills in the name from RS.ge's register.
      { key: 'personalId', label: 'პირადი ნომერი', placeholder: '11 ციფრი', validate: vPid, mono: true, inputMode: 'numeric' },
      {
        key: 'citizenship',
        label: 'მოქალაქეობა',
        type: 'select',
        options: () => [
          { value: 'GE', label: 'საქართველოს მოქალაქე' },
          { value: 'foreign', label: 'უცხოელი' },
        ],
      },
      { key: 'fullName', label: 'სახელი და გვარი', validate: vAnyName },
      { key: 'phone', label: 'ტელეფონი', type: 'tel', placeholder: '5XX XX XX XX', validate: vPhone },
    ],
    title: (r) => `${r.firstName} ${r.lastName}`,
    subtitle: (r) => `${fmtPhone(r.phone!)} · ${r.personalId}${r.citizenship === 'foreign' ? ' · უცხოელი' : ''}`,
    columns: [
      { label: 'სახელი', render: (r) => <span className="font-medium text-slate-900">{r.firstName} {r.lastName}</span> },
      { label: 'პირადი ნომერი', render: (r) => <span className="font-mono text-[13px]">{r.personalId}{r.citizenship === 'foreign' && <span className="ml-1.5 font-sans text-xs text-slate-500">უცხოელი</span>}</span> },
      { label: 'ტელეფონი', render: (r) => fmtPhone(r.phone!) },
    ],
  },
  {
    key: 'trucks',
    label: 'მანქანები',
    singular: 'მანქანის',
    icon: Truck,
    fields: [
      { key: 'model', label: 'მოდელი', placeholder: 'Volvo FH16' },
      { key: 'plateNumber', label: 'სახელმწიფო ნომერი', placeholder: 'AA-123-BB', validate: vPlate, mono: true },
      { key: 'trailerNumber', label: 'მისაბმელის ნომერი', placeholder: 'AA-123-BB', validate: vPlate, mono: true },
    ],
    title: (r) => r.plateNumber!,
    subtitle: (r) => `${r.model}${r.trailerNumber ? ` · მისაბმელი ${r.trailerNumber}` : ''}`,
    columns: [
      { label: 'ნომერი', render: (r) => <span className="font-mono text-[13px] font-medium text-slate-900">{r.plateNumber}</span> },
      { label: 'მოდელი', render: (r) => r.model },
      { label: 'მისაბმელი', render: (r) => <span className="font-mono text-[13px]">{r.trailerNumber || '—'}</span> },
    ],
  },
  {
    key: 'products',
    label: 'პროდუქტები',
    singular: 'პროდუქტის',
    icon: Package,
    // The same fields as RS.ge's own შტრიხკოდები list.
    fields: [
      { key: 'barCode', label: 'საქონლის კოდი', placeholder: 'CRS-05', mono: true },
      { key: 'name', label: 'საქონლის დასახელება', placeholder: 'ღორღი 0–5 მმ' },
      {
        key: 'unitId',
        label: 'ზომის ერთეული',
        type: 'select',
        options: (d) => rsUnits(d.rs).map((u) => ({ value: String(u.id), label: u.name })),
        initial: (d) => String(tonneUnit(d.rs)),
      },
      { key: 'unitTxt', label: 'ერთეულის დასახელება', placeholder: 'ტონა', showIf: (r) => r.unitId === String(RS_UNIT_OTHER), initial: () => 'ტონა' },
      { key: 'price', label: 'ერთეულის თანხა', placeholder: '0.00', suffix: '₾', inputMode: 'decimal', initial: () => '0', validate: vPrice },
      {
        key: 'vatType',
        label: 'დაბეგვრა',
        type: 'select',
        options: () => RS_VAT_TYPES.map((v) => ({ value: String(v.value), label: v.label })),
        initial: () => '0',
      },
    ],
    title: (r) => r.name!,
    subtitle: (r) => `${r.barCode} · ${r.unitTxt || '—'} · ${fmtPrice(r.price)} ₾ · ${vatLabel(r.vatType)}`,
    columns: [
      { label: 'საქონლის კოდი', render: (r) => <span className="font-mono text-[13px]">{r.barCode}</span> },
      { label: 'საქონლის დასახელება', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
      { label: 'ზომის ერთეული', render: (r) => r.unitTxt || '—' },
      { label: 'ერთეულის თანხა', render: (r) => <span className="tabular-nums">{fmtPrice(r.price)}</span> },
      { label: 'დაბეგვრა', render: (r) => vatLabel(r.vatType) },
    ],
  },
  {
    key: 'users',
    label: 'მომხმარებლები',
    singular: 'მომხმარებლის',
    icon: Users,
    fields: [
      { key: 'fullName', label: 'სახელი და გვარი', validate: vFullName },
      { key: 'phone', label: 'ტელეფონი', type: 'tel', placeholder: '5XX XX XX XX', validate: vPhone },
      { key: 'email', label: 'ელ-ფოსტა', type: 'email', validate: vEmail },
      {
        key: 'role',
        label: 'როლი',
        type: 'select',
        options: () => (['admin', 'operator', 'report'] as const).map((r) => ({ value: r, label: roleLabel[r] })),
      },
    ],
    title: (r) => `${r.firstName} ${r.lastName}`,
    subtitle: (r, d) => (r.role === 'operator' ? `${roleLabel.operator} · ${carrierNames(d, r)}` : roleLabel[r.role as 'admin']),
    columns: [
      { label: 'სახელი', render: (r) => <span className="font-medium text-slate-900">{r.firstName} {r.lastName}</span> },
      { label: 'როლი', render: (r) => <Badge tone={r.role === 'admin' ? 'violet' : r.role === 'operator' ? 'blue' : 'green'}>{roleLabel[r.role as 'admin']}</Badge> },
      { label: 'კარიერები', render: (r, d) => (r.role === 'operator' ? carrierNames(d, r) : '—') },
      { label: 'ელ-ფოსტა', render: (r) => r.email },
      { label: 'ტელეფონი', render: (r) => fmtPhone(r.phone!) },
    ],
  },
]

export function ReferenceData() {
  const d = useDb()
  const toast = useToast()
  const user = useUser()
  const [tabKey, setTabKey] = useState<RefCollection>('carriers')
  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[0]
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Rec | null>(null)
  const [deleting, setDeleting] = useState<Rec | null>(null)
  const [busy, setBusy] = useState(false)

  // Products and plates: read RS.ge's list when the tab opens, so ones added on the rs.ge portal show up.
  useEffect(() => {
    if (tabKey === 'products') products.sync().catch(() => {})
    if (tabKey === 'trucks') trucks.sync().catch(() => {})
  }, [tabKey])

  const rows = useMemo(() => {
    const list = active(d[tab.key] as unknown as (Rec & { deletedAt?: string })[])
    const n = q.trim().toLowerCase()
    const text = (r: Rec): string[] => {
      if (tab.key === 'routes') {
        const x = routeOf(d, r)
        return [carrierName(d, r.carrierId), x.start, x.end, r.scaleId ?? '', ...goodsOf(r).flatMap((g) => [g.name, g.barCode])]
      }
      return [...Object.values(r).filter((v) => typeof v === 'string'), ...(tab.key === 'users' ? [carrierNames(d, r)] : [])]
    }
    return n ? list.filter((r) => text(r).some((v) => v.toLowerCase().includes(n))) : list
  }, [d, tab.key, q])

  const blank = (): Rec => {
    const r: Rec = { id: '' }
    // Options can depend on fields before them.
    tab.fields.forEach((f) => (r[f.key] = f.initial ? f.initial(d) : f.type === 'select' ? (f.options!(d)[0]?.value ?? '') : ''))
    return r
  }

  const doDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await refs.remove(tab.key, deleting.id, user)
      toast('success', 'ჩანაწერი წაიშალა')
      setDeleting(null)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="ცნობარები"
        actions={
          <span className="hidden sm:block">
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing(blank())}>
              {tab.singular} დამატება
            </Button>
          </span>
        }
      />

      <FilterChips
        className="-mx-4 mb-4 px-4 sm:mx-0 sm:px-0"
        value={tabKey}
        onChange={(k) => {
          setTabKey(k)
          setQ('')
        }}
        options={TABS.map((t) => ({ value: t.key, label: t.label, icon: <t.icon />, count: active(d[t.key] as { deletedAt?: string }[]).length }))}
      />

      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ძებნა…" className="pl-9" />
        </div>
        <span className="sm:hidden">
          <Button className="w-11 px-0" icon={<Plus className="size-4" />} onClick={() => setEditing(blank())} aria-label={`${tab.singular} დამატება`} />
        </span>
      </div>

      {(tab.key === 'products' || tab.key === 'trucks') && <RsListLine what={tab.key} />}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<tab.icon className="size-6" />} title="ჩანაწერები ვერ მოიძებნა" />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-separator text-left text-xs text-slate-500">
                    {tab.columns.map((c) => (
                      <th key={c.label} className="px-5 py-3 font-medium">
                        {c.label}
                      </th>
                    ))}
                    <th className="w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-separator">
                  {rows.map((r) => (
                    <tr key={r.id} className="group hover:bg-slate-50/70">
                      {tab.columns.map((c) => (
                        <td key={c.label} className="px-5 py-3 text-slate-600">
                          {c.render(r, d)}
                        </td>
                      ))}
                      <td className="pr-4 text-right whitespace-nowrap">
                        <RowActions onEdit={() => setEditing({ ...r })} onDelete={() => setDeleting(r)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-separator md:hidden">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-brand-500/12 text-brand-600">
                    <tab.icon className="size-5" />
                  </div>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setEditing({ ...r })}>
                    <p className="truncate text-sm font-medium text-slate-900">{tab.title(r, d)}</p>
                    <p className="truncate text-xs text-slate-500">{tab.subtitle(r, d)}</p>
                  </button>
                  <RowActions onEdit={() => setEditing({ ...r })} onDelete={() => setDeleting(r)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {editing && <EditModal tab={tab} rec={editing} onClose={() => setEditing(null)} />}

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={doDelete}
        disabled={!!deleting && !!refs.blocker(tab.key, deleting.id, user)}
        busy={busy}
        title={`${tab.singular} წაშლა?`}
        message={deleting && <DeleteMessage col={tab.key} id={deleting.id} name={tab.title(deleting, d)} />}
      />
    </>
  )
}

function DeleteMessage({ col, id, name }: { col: RefCollection; id: string; name: string }) {
  const user = useUser()
  const d = useDb()
  const blocker = refs.blocker(col, id, user)
  const used = refs.shipmentCount(col, id)
  const routeCount = col === 'carriers' ? active(d.routes).filter((x) => x.carrierId === id).length : 0
  return (
    <>
      <b className="text-slate-900">{name}</b> წაიშლება სიიდან და ახალ რეისებში ვეღარ აირჩევა.
      {blocker ? (
        <p className="mt-2 rounded-lg bg-rose-50 p-2 text-rose-700">წაშლა შეუძლებელია: {blocker}</p>
      ) : used ? (
        <p className="mt-2 rounded-lg bg-slate-100 p-2 text-slate-600">გამოიყენება {used} რეისში — ეს რეისები და რეპორტები კვლავ აჩვენებს ამ ჩანაწერს.</p>
      ) : null}
      {!blocker && col === 'products' && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-amber-800">პროდუქტი RS.ge-ს პროდუქტების სიიდანაც წაიშლება. უკვე ატვირთული ზედნადებები არ შეიცვლება.</p>}
      {!blocker && routeCount > 0 && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-amber-800">მასთან ერთად წაიშლება ამ კარიერის {routeCount} მარშრუტი.</p>}
      {!blocker && col === 'users' && id === user.id && (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-amber-800">ეს შენი ანგარიშია — წაშლის შემდეგ სისტემიდან გამოხვალ.</p>
      )}
    </>
  )
}

/** Products and trucks tabs: when RS.ge's list was last read, why it failed, and a "read now" button. */
function RsListLine({ what }: { what: 'products' | 'trucks' }) {
  const d = useDb()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const isProducts = what === 'products'
  const error = isProducts ? d.rs.productsSyncError : d.rs.platesError
  const list = isProducts ? 'პროდუქტების სია' : 'მანქანების ნომრების სია'
  const run = async () => {
    setBusy(true)
    try {
      await (isProducts ? products : trucks).sync(true)
      toast('success', `${list} განახლდა RS.ge-დან`)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // Trucks stored here whose plate RS.ge's list doesn't have: hidden from the pickers until it does.
  const offRs = isProducts ? [] : d.trucks.filter((t) => t.deletedAt === 'rs')
  const clear = async () => {
    setBusy(true)
    try {
      const r = await (isProducts ? products : trucks).clear()
      const noun = isProducts ? 'პროდუქტი' : 'მანქანა'
      if (r.failed) toast('error', `წაიშალა ${r.deleted} ${noun}, RS.ge-მ ${r.failed} არ წაშალა`)
      else toast('success', `წაიშალა ${r.deleted} ${noun}`)
      setClearing(false)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // Trucks off RS.ge's list (deletedAt 'rs') are stored here and go too.
  const count = isProducts ? active(d.products).length : d.trucks.filter((t) => !t.deletedAt || t.deletedAt === 'rs').length
  const push = async () => {
    setBusy(true)
    try {
      const r = await trucks.pushPlates()
      toast('success', `RS.ge-ს სიას დაემატა ${r.added} ნომერი`)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {offRs.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <p>
            RS.ge-ს სიაში არ არის: <span className="font-mono text-[13px]">{offRs.map((t) => t.plateNumber).join(', ')}</span> — ამ მანქანებს რეისზე ვერ აირჩევ, სანამ ნომერი RS.ge-ს სიაში არ დაემატება.
          </p>
          <Button size="sm" variant="secondary" onClick={() => void push()} loading={busy}>
            RS.ge-ზე დამატება
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-3">
        <RsReadLine error={error} busy={busy} onRefresh={() => void run()} />
        {count > 0 && (
          <DeleteButton onClick={() => setClearing(true)} disabled={busy} className="mb-4">
            ყველას წაშლა
          </DeleteButton>
        )}
      </div>
      <ConfirmModal
        open={clearing}
        onClose={() => setClearing(false)}
        onConfirm={() => void clear()}
        busy={busy}
        title={`წაიშალოს ${count} ${isProducts ? 'პროდუქტი' : 'მანქანა'}?`}
        confirmLabel="წაშლა"
        message={isProducts ? 'RS.ge-დანაც წაიშლება.' : 'ნომრები RS.ge-ს სიიდანაც წაიშლება. უკვე ატვირთული ზედნადებები არ შეიცვლება.'}
      />
    </>
  )
}

function RsReadLine({ error, busy, onRefresh }: { error?: string; busy: boolean; onRefresh: () => void }) {
  return (
    <p className="mb-4 ml-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
      {error && <span className="text-amber-700">{error}</span>}
      <RefreshButton busy={busy} onClick={onRefresh} />
    </p>
  )
}

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <span className="inline-flex gap-1">
      <button onClick={onEdit} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="რედაქტირება">
        <Pencil className="size-4" />
      </button>
      <button onClick={onDelete} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="წაშლა">
        <Trash2 className="size-4" />
      </button>
    </span>
  )
}

function EditModal({ tab, rec, onClose }: { tab: TabDef; rec: Rec; onClose: () => void }) {
  const d = useDb()
  const toast = useToast()
  // Drivers saved before citizenship existed are Georgian citizens.
  const [form, setR] = useState<Rec>(() => {
    // The form edits text: numbers (a product's unit) become strings.
    const x = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])) as Rec
    // Fields added later (e.g. a product's price and VAT type) start at their default on older records.
    if (x.id) for (const f of tab.fields) if (x[f.key] == null && f.initial) x[f.key] = f.initial(d, x)
    // სახელი and გვარი are typed in one field.
    if (tab.fields.some((f) => f.key === 'fullName')) x.fullName = [x.firstName, x.lastName].filter(Boolean).join(' ')
    return tab.key === 'drivers' && !x.citizenship ? { ...x, citizenship: 'GE' } : x
  })
  const liveCarriers = active(d.carriers)
  // Deleted carriers drop out of the list; saving removes them from the operator.
  const [carrierIds, setCarrierIds] = useState<string[]>(() => carrierIdsOf(rec).filter((id) => liveCarriers.some((c) => c.id === id)))
  const pickCarriers = tab.key === 'users' && form.role === 'operator'
  // A route's goods lines, as typed.
  const isRoute = tab.key === 'routes'
  const [goods, setGoods] = useState<GoodDraft[]>(() => (rec.id && goodsOf(rec).length ? goodsOf(rec).map(toDraft) : [blankGood(d)]))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const isNew = !rec.id

  // A Georgian driver's number is looked up on RS.ge as it is typed: the name it has fills the name
  // field (while that is empty or still holds an earlier fill), and a number it doesn't know can't be saved.
  const isDriver = tab.key === 'drivers'
  const pid = (form.personalId ?? '').trim()
  const canSearch = isDriver && form.citizenship !== 'foreign'
  const { lookup, search } = useRsName(canSearch ? pid : '')
  const autoName = useRef('')
  // Set by the search button: the name found replaces whatever was typed.
  const searched = useRef(false)
  useEffect(() => {
    if (lookup?.state === 'loading') return
    const forced = searched.current
    searched.current = false
    // A number RS.ge doesn't know takes away the name an earlier number filled in.
    if (lookup?.state === 'missing') setR((x) => (autoName.current && x.fullName === autoName.current ? { ...x, fullName: '' } : x))
    if (lookup?.state !== 'found') return
    const name = lookup.name!
    setR((x) => (forced || !x.fullName?.trim() || x.fullName === autoName.current ? { ...x, fullName: name } : x))
    setErrors((x) => ({ ...x, fullName: '' }))
    autoName.current = name
  }, [lookup])
  const pidMissing = lookup?.state === 'missing' ? 'RS.ge-ს რეესტრში ვერ მოიძებნა' : ''
  const searchPid = () => {
    const msg = vPid(pid, form)
    if (msg) return setErrors((x) => ({ ...x, personalId: pid ? msg : 'შეიყვანე პირადი ნომერი' }))
    searched.current = true
    search()
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const r = form
    const errs: Record<string, string> = {}
    for (const f of tab.fields) {
      if (f.showIf && !f.showIf(r)) continue
      const v = (r[f.key] ?? '').trim()
      if (!v) {
        if (!f.optional) errs[f.key] = f.type === 'select' ? 'აირჩიე' : 'სავალდებულო ველი'
        continue
      }
      const msg = f.validate?.(v, r)
      if (msg) errs[f.key] = msg
    }
    if (pickCarriers && !carrierIds.length) errs.carrierIds = liveCarriers.length ? 'მონიშნე მინიმუმ ერთი კარიერი' : 'ჯერ დაამატე კარიერი — ოპერატორი კარიერის გარეშე ვერ შეიქმნება'
    if (isRoute) Object.assign(errs, checkGoods(goods))
    if (pidMissing && !errs.personalId) errs.personalId = pidMissing
    setErrors(errs)
    setSaveError('')
    if (Object.keys(errs).length) return
    setBusy(true)
    try {
      const clean: Rec = { id: r.id }
      for (const f of tab.fields) {
        if (f.showIf && !f.showIf(r)) continue
        let v = (r[f.key] ?? '').trim()
        if (f.key === 'plateNumber' || f.key === 'trailerNumber') v = v.toUpperCase()
        if (f.key === 'phone') v = fmtPhone(v)
        if (f.key === 'price' || f.key === 'transportCost') v = v.replace(',', '.')
        if (f.key === 'fullName') {
          const [first, ...rest] = v.split(/\s+/)
          Object.assign(clean, { firstName: first, lastName: rest.join(' ') })
          continue
        }
        clean[f.key] = v
      }
      if (pickCarriers) Object.assign(clean, { carrierIds })
      if (isRoute) Object.assign(clean, { goods: fromDrafts(d, goods) })
      await refs.save(tab.key, clean as never)
      toast('success', isNew ? 'ჩანაწერი დაემატა' : 'ცვლილებები შენახულია')
      onClose()
    } catch (err) {
      setSaveError((err as Error).message)
      setBusy(false)
    }
  }

  const setField = (key: string, value: string) => {
    setR((x) => ({ ...x, [key]: value }))
    setErrors((x) => ({ ...x, [key]: '' }))
    // A new operator with only one carrier to choose from gets it right away.
    if (key === 'role' && value === 'operator' && !carrierIds.length && liveCarriers.length === 1) setCarrierIds([liveCarriers[0].id])
  }

  const r = form
  const shown = tab.fields.filter((f) => !f.showIf || f.showIf(r))
  const fields = shown.filter((f) => !f.afterGoods)
  const lastFields = shown.filter((f) => f.afterGoods)
  const routeStart = tab.key === 'routes' ? d.carriers.find((c) => c.id === r.carrierId)?.startAddress : undefined

  const renderField = (f: FieldDef, fields: FieldDef[]) => {
    const opts = f.type === 'select' ? f.options!(d) : []
    const rich = opts.some((o) => o.icon)
    return (
      <div key={f.key} className={cx((f.wide || (fields.length % 2 === 1 && f === fields[0])) && 'sm:col-span-2')}>
        <Field
          label={f.label}
          error={errors[f.key] || (f.key === 'personalId' && isDriver ? pidMissing : '')}
          hint={isDriver && f.key === 'fullName' && autoName.current && r.fullName === autoName.current ? 'შეივსო RS.ge-დან — შეგიძლია შეცვალო' : undefined}
        >
          {f.type === 'select' ? (
            <Select rich={rich} searchable={rich && opts.length > 5} value={r[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.placeholder} invalid={!!errors[f.key]} disabled={!opts.length}>
              {opts.map((o) => (
                <option key={o.value} value={o.value} label={o.label} data-search={o.sub}>
                  {rich ? <OptionRow icon={o.icon} title={o.label} sub={o.sub} /> : o.label}
                </option>
              ))}
            </Select>
          ) : canSearch && f.key === 'personalId' ? (
            <div className="flex gap-2">
              <Input
                value={r.personalId ?? ''}
                placeholder={f.placeholder}
                inputMode="numeric"
                maxLength={11}
                className="font-mono"
                invalid={!!errors.personalId || !!pidMissing}
                onChange={(e) => setField('personalId', e.target.value.replace(/\D/g, ''))}
                // Enter looks the number up instead of saving the form.
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  searchPid()
                }}
              />
              <button
                type="button"
                onClick={searchPid}
                disabled={lookup?.state === 'loading'}
                title="სახელის მოძებნა და ნომრის შემოწმება RS.ge-ზე"
                className="pressable flex h-11 shrink-0 items-center gap-1.5 rounded-[10px] bg-fill px-3.5 text-[15px] font-semibold text-brand-600 transition-colors hover:bg-brand-500/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-default sm:h-9 sm:rounded-[8px] sm:px-3 sm:text-[14px]"
              >
                {lookup?.state === 'loading' ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                ძებნა
              </button>
            </div>
          ) : (
            <Input
              type={f.type ?? 'text'}
              value={r[f.key] ?? ''}
              placeholder={isDriver && f.key === 'fullName' && r.citizenship !== 'foreign' ? 'შეივსება პირადი ნომრით' : f.placeholder}
              inputMode={f.inputMode}
              suffix={f.suffix}
              className={f.mono ? 'font-mono' : undefined}
              invalid={!!errors[f.key] || (f.key === 'personalId' && isDriver && !!pidMissing)}
              onChange={(e) => setField(f.key, e.target.value)}
            />
          )}
        </Field>
        {isDriver && f.key === 'personalId' && !errors.personalId && lookup && lookup.state !== 'missing' && (
          <RsNameLine lookup={lookup} current={r.fullName ?? ''} onUse={(name) => setField('fullName', name)} />
        )}
        {f.key === 'carrierId' && routeStart !== undefined && (
          <p className="mt-1.5 px-1 text-sm">
            <span className="text-slate-500">დაწყების მისამართი: </span>
            <span className="font-medium text-slate-900">{routeStart || '—'}</span>
          </p>
        )}
      </div>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      wide={isRoute}
      title={`${tab.singular} ${isNew ? 'დამატება' : 'რედაქტირება'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            გაუქმება
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            {isNew ? 'დამატება' : 'შენახვა'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2" noValidate>
        {saveError && (
          <div role="alert" className="flex items-start gap-2 rounded-[10px] bg-rose-50 px-4 py-3 text-sm text-rose-700 sm:col-span-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-500" />
            <span>{saveError}</span>
          </div>
        )}
        {fields.map((f) => renderField(f, fields))}

        {isRoute && (
          <div className="sm:col-span-2">
            <RouteGoodsEditor d={d} goods={goods} onChange={setGoods} errors={errors} onClearError={(k) => setErrors((x) => ({ ...x, [k]: '' }))} />
          </div>
        )}

        {lastFields.map((f) => renderField(f, lastFields))}

        {pickCarriers && (
          <div className="sm:col-span-2">
            {/* Not a <label> (Field): a click on the field would go to the first tag's ✕ and remove that carrier. */}
            <span className="mb-1 ml-1 block text-[12px] font-medium text-slate-600">კარიერები</span>
            <MultiSelect
              aria-label="კარიერები"
              placeholder="აირჩიე ან მოძებნე კარიერი"
              icon={<Building2 />}
              sheetTitle="კარიერები"
              options={liveCarriers.map((c) => ({ value: c.id, label: c.name, sub: c.startAddress || undefined }))}
              value={carrierIds}
              invalid={!!errors.carrierIds}
              onChange={(v) => {
                setCarrierIds(v)
                setErrors((x) => ({ ...x, carrierIds: '' }))
              }}
            />
            {errors.carrierIds && <span className="mt-1 ml-1 block text-xs text-rose-600">{errors.carrierIds}</span>}
          </div>
        )}

        <button type="submit" className="hidden" />
      </form>
    </Modal>
  )
}

type NameLookup = { state: 'loading' | 'found' | 'missing' | 'error'; name?: string; error?: string }

/** Answers already read, so retyping a number doesn't ask RS.ge again. */
const rsNames = new Map<string, string>()

/**
 * What RS.ge's register says about an 11-digit personal number; null for anything else.
 * Asked on its own as the number is typed; `search` asks again right away, past the remembered answer.
 */
function useRsName(pid: string): { lookup: NameLookup | null; search: () => void } {
  const [res, setRes] = useState<NameLookup | null>(null)
  // Each question gets a number; an answer to an older one (an earlier number) is dropped.
  const seq = useRef(0)
  const ask = (fresh: boolean) => {
    const n = ++seq.current
    const known = fresh ? undefined : rsNames.get(pid)
    if (known !== undefined) return setRes({ state: known ? 'found' : 'missing', name: known })
    setRes({ state: 'loading' })
    rsSettings.nameOf(pid).then(
      (r) => {
        rsNames.set(pid, r.name)
        if (seq.current === n) setRes({ state: r.name ? 'found' : 'missing', name: r.name })
      },
      (e: Error) => seq.current === n && setRes({ state: 'error', error: e.message }),
    )
  }
  useEffect(() => {
    seq.current++
    if (!/^\d{11}$/.test(pid)) return setRes(null)
    if (rsNames.has(pid)) return ask(false)
    setRes({ state: 'loading' })
    const t = setTimeout(() => ask(false), 250)
    return () => {
      clearTimeout(t)
      seq.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])
  return { lookup: res, search: () => ask(true) }
}

/** Below a driver's personal number: the lookup in progress, the name RS.ge has (with a button to use it), or why it failed. */
function RsNameLine({ lookup, current, onUse }: { lookup: NameLookup; current: string; onUse: (name: string) => void }) {
  if (lookup.state === 'loading')
    return (
      <p className="mt-1 ml-1 flex items-center gap-1.5 text-xs text-slate-500">
        <Loader2 className="size-3.5 animate-spin" /> RS.ge-ზე მოწმდება…
      </p>
    )
  if (lookup.state === 'error') return <p className="mt-1 ml-1 text-xs text-amber-700">RS.ge-ზე ვერ შემოწმდა: {lookup.error}</p>
  const name = lookup.name!
  return (
    <p className="mt-1 ml-1 flex flex-wrap items-center gap-x-1.5 text-xs text-emerald-700">
      <CircleCheck className="size-3.5 shrink-0" />
      <span>
        RS.ge: <b className="font-medium">{name}</b>
      </span>
      {current.trim() !== name && (
        <button type="button" onClick={() => onUse(name)} className="font-medium text-brand-600 hover:underline">
          სახელად ჩასმა
        </button>
      )}
    </p>
  )
}
