import { AlertTriangle, Building2, Check, Loader2, Package, Pencil, Plus, Route, Search, Trash2, Truck, UserRound, Users } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { products, refs, rsSettings, trucks, type RefCollection } from '../api'
import { TIN_RE } from '../components/TinLookup'
import { Badge, Button, Card, ConfirmModal, DeleteButton, EmptyState, Field, FilterChips, Input, Modal, PageHeader, RefreshButton, Select } from '../components/ui'
import { useToast } from '../components/toast'
import { active, cx, phoneKey } from '../lib/util'
import { useDb } from '../api/store'
import { roleLabel, useUser } from '../session'
import { routeAddresses, routeLabel } from '../lib/route'
import { RS_UNIT_OTHER, RS_VAT_TYPES, rsUnits, tonneUnit, waybillDefaults, WAYBILL_TYPES, waybillTypeLabel } from '../lib/rs'
import type { CarrierRoute, Database } from '../types'
import { OptionRow } from '../components/pickers'
import { WAYBILL_TYPE_ICON } from '../components/icons'

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
  /** Can't be changed once saved. */
  fixed?: boolean
  /** A tax ID: a search button (or Enter) looks its name up on RS.ge and puts it in this other field. */
  lookup?: string
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
const fmtPhone = (v: string) => phoneKey(v).replace(/^(\d{3})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4')
/** Georgian citizens: 11-digit personal number. Foreigners: passport / ID number as issued. */
const vPid = (v: string, r: Rec) => (r.citizenship === 'foreign' || /^\d{11}$/.test(v.trim()) ? null : 'პირადი ნომერი უნდა იყოს 11 ციფრი')
const vEmail = (v: string) => (/^\S+@\S+\.\S+$/.test(v.trim()) ? null : 'ელ-ფოსტა არასწორია')
const vPlate = (v: string) => (/^[A-Z]{2}-\d{3}-[A-Z]{2}$/.test(v.trim().toUpperCase()) ? null : 'ფორმატი: AA-123-BB')

const vPrice = (v: string) => (Number(v.replace(',', '.')) >= 0 ? null : 'შეიყვანე 0 ან მეტი')
/** A product's unit price as RS.ge shows it: 10 → '10.00'. */
const fmtPrice = (v?: string) => (Number(v) || 0).toFixed(2)
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

/** Connected to RS.ge (the admin's copy shows the service user). Products and plates are RS.ge's, so they need it. */
const rsConnected = (d: Database) => !!d.rs.su && !!d.rs.spSet

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
      { key: 'endAddress', label: 'დასრულების მისამართი', placeholder: 'ჩაბარების პუნქტი' },
      { key: 'scaleId', label: 'სასწორის ID', placeholder: 'SC-01', mono: true },
      {
        key: 'waybillType',
        label: 'ზედნადების ტიპი',
        type: 'select',
        wide: true,
        // Routes saved without a type show the one their waybills got (buyer set → 2, else 1).
        initial: (d, r) => String(waybillDefaults(d.rs, r as unknown as CarrierRoute | undefined).type),
        options: () => WAYBILL_TYPES.map((t) => ({ value: String(t.value), label: t.label, icon: WAYBILL_TYPE_ICON[t.value], sub: t.hint })),
      },
      {
        key: 'buyerTin',
        label: 'მყიდველის ს/ნ',
        optional: true,
        mono: true,
        lookup: 'buyerName',
        showIf: (r) => r.waybillType !== '1',
      },
      {
        key: 'buyerName',
        label: 'მყიდველის დასახელება',
        optional: true,
        showIf: (r) => r.waybillType !== '1',
      },
    ],
    title: (r, d) => routeLabel(d.carriers, r as unknown as CarrierRoute),
    subtitle: (r, d) => [carrierName(d, r.carrierId), r.buyerName || r.buyerTin].filter(Boolean).join(' · '),
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
        label: 'ზედნადები',
        render: (r, d) => {
          const w = waybillDefaults(d.rs, r as unknown as CarrierRoute)
          return (
            <span>
              {waybillTypeLabel(w.type)}
              {w.type !== 1 && <span className="block text-xs text-slate-500">{w.buyerName || w.buyerTin || 'მყიდველი არ არის'}</span>}
            </span>
          )
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
      { key: 'fullName', label: 'სახელი და გვარი', validate: vAnyName },
      { key: 'personalId', label: 'პირადი ნომერი', placeholder: '11 ციფრი', validate: vPid, mono: true },
      { key: 'phone', label: 'ტელეფონი', type: 'tel', placeholder: '5XX XX XX XX', validate: vPhone },
      {
        key: 'citizenship',
        label: 'მოქალაქეობა',
        type: 'select',
        options: () => [
          { value: 'GE', label: 'საქართველოს მოქალაქე' },
          { value: 'foreign', label: 'უცხოელი' },
        ],
      },
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
      { key: 'barCode', label: 'საქონლის კოდი', placeholder: 'CRS-05', mono: true, fixed: true },
      { key: 'name', label: 'საქონლის დასახელება', placeholder: 'ღორღი 0–5 მმ' },
      {
        key: 'unitId',
        label: 'ზომის ერთეული',
        type: 'select',
        options: (d) => rsUnits(d.rs).map((u) => ({ value: String(u.id), label: u.name })),
        initial: (d) => String(tonneUnit(d.rs)),
      },
      { key: 'unitTxt', label: 'ერთეულის დასახელება', placeholder: 'ტონა', showIf: (r) => r.unitId === String(RS_UNIT_OTHER), initial: () => 'ტონა' },
      { key: 'price', label: 'ერთეულის თანხა (₾)', placeholder: '0.00', initial: () => '0', validate: vPrice },
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
  const productsLocked = (tab.key === 'products' || tab.key === 'trucks') && !rsConnected(d)

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
        return [carrierName(d, r.carrierId), x.start, x.end, r.scaleId ?? '', r.buyerName ?? '', r.buyerTin ?? '']
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
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing(blank())} disabled={productsLocked}>
              {tab.singular} დამატება
            </Button>
          </span>
        }
      />

      <FilterChips
        className="mb-4"
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
          <Button className="w-11 px-0" icon={<Plus className="size-4" />} onClick={() => setEditing(blank())} disabled={productsLocked} aria-label={`${tab.singular} დამატება`} />
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
  if (!rsConnected(d)) {
    return (
      <p className="mb-4 rounded-[10px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
        {isProducts ? 'პროდუქტები RS.ge-დან მოდის' : 'მანქანების ნომრები RS.ge-ზე ინახება'} — დასამატებლად და შესაცვლელად ჯერ დაუკავშირდი RS.ge-ს (RS.ge-ს გვერდი).
      </p>
    )
  }
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
      const r = await products.clear()
      if (r.failed) toast('error', `წაიშალა ${r.deleted} პროდუქტი, RS.ge-მ ${r.failed} არ წაშალა`)
      else toast('success', `წაიშალა ${r.deleted} პროდუქტი`)
      setClearing(false)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const count = isProducts ? active(d.products).length : 0
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
        title={`წაიშალოს ${count} პროდუქტი?`}
        confirmLabel="წაშლა"
        message="RS.ge-დანაც წაიშლება."
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
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [searching, setSearching] = useState('')
  const isNew = !rec.id

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
        if (f.key === 'price') v = v.replace(',', '.')
        if (f.key === 'fullName') {
          const [first, ...rest] = v.split(/\s+/)
          Object.assign(clean, { firstName: first, lastName: rest.join(' ') })
          continue
        }
        clean[f.key] = v
      }
      if (pickCarriers) Object.assign(clean, { carrierIds })
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

  /** Looks a tax ID field's name up on RS.ge (any number: one RS.ge doesn't know is typed by hand). */
  const search = async (f: FieldDef) => {
    const tin = (form[f.key] ?? '').trim()
    if (!tin) return setErrors((x) => ({ ...x, [f.key]: 'შეიყვანე ნომერი' }))
    setSearching(f.key)
    try {
      const { name } = await rsSettings.nameFromTin(tin, !TIN_RE.test(tin))
      if (name) setField(f.lookup!, name)
      setErrors((x) => ({ ...x, [f.key]: name ? '' : 'RS.ge-ზე ვერ მოიძებნა — დასახელება შეიყვანე ხელით' }))
    } catch (err) {
      setErrors((x) => ({ ...x, [f.key]: (err as Error).message }))
    } finally {
      setSearching('')
    }
  }

  const r = form
  const fields = tab.fields.filter((f) => !f.showIf || f.showIf(r))
  const routeStart = tab.key === 'routes' ? d.carriers.find((c) => c.id === r.carrierId)?.startAddress : undefined

  return (
    <Modal
      open
      onClose={onClose}
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
        {fields.map((f) => {
          const opts = f.type === 'select' ? f.options!(d) : []
          const rich = opts.some((o) => o.icon)
          return (
            <div key={f.key} className={cx((f.wide || (fields.length % 2 === 1 && f === fields[0])) && 'sm:col-span-2')}>
              <Field label={f.label} error={errors[f.key]}>
                {f.type === 'select' ? (
                  <Select rich={rich} searchable={rich && opts.length > 5} value={r[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.placeholder} invalid={!!errors[f.key]} disabled={!opts.length}>
                    {opts.map((o) => (
                      <option key={o.value} value={o.value} label={o.label} data-search={o.sub}>
                        {rich ? <OptionRow icon={o.icon} title={o.label} sub={o.sub} /> : o.label}
                      </option>
                    ))}
                  </Select>
                ) : f.lookup ? (
                  <div className="flex gap-2">
                    <Input
                      value={r[f.key] ?? ''}
                      placeholder={f.placeholder}
                      inputMode="numeric"
                      className={f.mono ? 'font-mono' : undefined}
                      invalid={!!errors[f.key]}
                      onChange={(e) => setField(f.key, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        void search(f)
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void search(f)}
                      disabled={searching === f.key}
                      aria-label="RS.ge-ზე ძებნა"
                      title="RS.ge-ზე ძებნა"
                      className="pressable inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[10px] bg-fill text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-wait"
                    >
                      {searching === f.key ? <Loader2 className="size-[18px] animate-spin" /> : <Search className="size-[18px]" />}
                    </button>
                  </div>
                ) : (
                  <Input
                    type={f.type ?? 'text'}
                    value={r[f.key] ?? ''}
                    placeholder={f.placeholder}
                    inputMode={f.key === 'personalId' ? 'numeric' : undefined}
                    className={f.mono ? 'font-mono' : undefined}
                    invalid={!!errors[f.key]}
                    disabled={!!f.fixed && !isNew}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                )}
              </Field>
              {f.key === 'carrierId' && routeStart !== undefined && (
                <p className="mt-1.5 px-1 text-sm">
                  <span className="text-slate-500">დაწყების მისამართი: </span>
                  <span className="font-medium text-slate-900">{routeStart || '—'}</span>
                </p>
              )}
            </div>
          )
        })}

        {pickCarriers && (
          <Chips
            label="კარიერები"
            items={liveCarriers.map((c) => ({ id: c.id, label: c.name }))}
            value={carrierIds}
            onChange={(v) => {
              setCarrierIds(v)
              setErrors((x) => ({ ...x, carrierIds: '' }))
            }}
            error={errors.carrierIds}
          />
        )}

        <button type="submit" className="hidden" />
      </form>
    </Modal>
  )
}

/** Toggle buttons for picking several records (an operator's carriers). */
function Chips({ label, items, value, onChange, error }: { label: string; items: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; error?: string }) {
  return (
    <div className="sm:col-span-2">
      <p className="mb-1.5 ml-1 text-[13px] text-slate-500">{label}</p>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
          {items.map((x) => {
            const on = value.includes(x.id)
            return (
              <button
                key={x.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? value.filter((v) => v !== x.id) : [...value, x.id])}
                className={cx(
                  'pressable flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm ring-1 transition-colors',
                  on ? 'bg-brand-600 font-medium text-white ring-brand-600' : 'bg-surface text-slate-700 ring-slate-200 hover:bg-fill',
                )}
              >
                {on && <Check className="size-4" />}
                {x.label}
              </button>
            )
          })}
        </div>
      )}
      {error && <p className="mt-1 ml-1 text-xs text-rose-600">{error}</p>}
    </div>
  )
}
