import { Building2, Lock, Package, Pencil, Plus, Search, Trash2, Truck, UserRound, Users, X } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { cargo, refs, type RefCollection } from '../api'
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, PageHeader, Select } from '../components/ui'
import { useToast } from '../components/toast'
import { cx } from '../lib/util'
import { useDb } from '../mock/db'
import { roleLabel, useUser } from '../session'
import type { Database, Destination } from '../types'

type Rec = Record<string, string | undefined> & { id: string }

interface FieldDef {
  key: string
  label: string
  type?: 'text' | 'tel' | 'email' | 'select'
  placeholder?: string
  options?: (d: Database) => { value: string; label: string }[]
  validate?: (v: string, rec: Rec) => string | null
  optional?: boolean
  showIf?: (rec: Rec) => boolean
  mono?: boolean
}

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

const phoneRe = /^\+?995\s?5\d{2}(\s?\d{2}){3}$/
const vPhone = (v: string) => (phoneRe.test(v.trim()) ? null : 'ფორმატი: +995 5XX XX XX XX')
const vPid = (v: string) => (/^\d{11}$/.test(v.trim()) ? null : 'პირადი ნომერი უნდა იყოს 11 ციფრი')
const vEmail = (v: string) => (/^\S+@\S+\.\S+$/.test(v.trim()) ? null : 'ელ-ფოსტა არასწორია')
const vPlate = (v: string) => (/^[A-Z]{2}-\d{3}-[A-Z]{2}$/.test(v.trim().toUpperCase()) ? null : 'ფორმატი: AA-123-BB')

/** Carrier records carry a destinations array next to their string fields. */
const destsOf = (r: Rec) => ((r as unknown as { destinations?: Destination[] }).destinations ?? [])

const carrierName = (d: Database, id?: string) => d.carriers.find((c) => c.id === id)?.name ?? '—'
const carrierOptions = (d: Database) => d.carriers.map((c) => ({ value: c.id, label: c.name }))

const TABS: TabDef[] = [
  {
    key: 'carriers',
    label: 'კარიერები',
    singular: 'კარიერის',
    icon: Building2,
    fields: [
      { key: 'name', label: 'დასახელება', placeholder: 'კავკასია ლოჯისტიკი' },
      { key: 'code', label: 'კოდი (cardCode)', placeholder: 'C-1004', mono: true },
      { key: 'startAddress', label: 'დაწყების მისამართი', placeholder: 'დატვირთვის პუნქტი' },
    ],
    title: (r) => r.name!,
    subtitle: (r) => `${r.startAddress} → ${destsOf(r).map((x) => x.address).join(', ') || '—'}`,
    columns: [
      { label: 'სახელი', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
      { label: 'კოდი', render: (r) => <span className="font-mono text-[13px]">{r.code}</span> },
      { label: 'დაწყების მისამართი', render: (r) => r.startAddress },
      {
        label: 'დასრულების მისამართები',
        render: (r) => (
          <ul className="space-y-0.5">
            {destsOf(r).map((x) => (
              <li key={x.id}>
                {x.address} <span className="font-mono text-xs text-slate-400">{x.scaleId}</span>
              </li>
            ))}
          </ul>
        ),
      },
    ],
  },
  {
    key: 'drivers',
    label: 'მძღოლები',
    singular: 'მძღოლის',
    icon: UserRound,
    fields: [
      { key: 'firstName', label: 'სახელი' },
      { key: 'lastName', label: 'გვარი' },
      { key: 'personalId', label: 'პირადი ნომერი', placeholder: '11 ციფრი', validate: vPid, mono: true },
      { key: 'phone', label: 'ტელეფონი', type: 'tel', placeholder: '+995 5XX XX XX XX', validate: vPhone },
    ],
    title: (r) => `${r.firstName} ${r.lastName}`,
    subtitle: (r) => `${r.phone} · ${r.personalId}`,
    columns: [
      { label: 'სახელი', render: (r) => <span className="font-medium text-slate-900">{r.firstName} {r.lastName}</span> },
      { label: 'პირადი ნომერი', render: (r) => <span className="font-mono text-[13px]">{r.personalId}</span> },
      { label: 'ტელეფონი', render: (r) => r.phone },
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
      { key: 'trailerNumber', label: 'მისაბმელის ნომერი', placeholder: 'TR-123-AA', optional: true, mono: true },
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
    key: 'users',
    label: 'მომხმარებლები',
    singular: 'მომხმარებლის',
    icon: Users,
    fields: [
      { key: 'firstName', label: 'სახელი' },
      { key: 'lastName', label: 'გვარი' },
      { key: 'phone', label: 'ტელეფონი', type: 'tel', placeholder: '+995 5XX XX XX XX', validate: vPhone },
      { key: 'email', label: 'ელ-ფოსტა', type: 'email', validate: vEmail },
      {
        key: 'role',
        label: 'როლი',
        type: 'select',
        options: () => (['admin', 'operator', 'report'] as const).map((r) => ({ value: r, label: roleLabel[r] })),
      },
      { key: 'carrierId', label: 'კარიერი', type: 'select', options: carrierOptions, showIf: (r) => r.role === 'operator' },
    ],
    title: (r) => `${r.firstName} ${r.lastName}`,
    subtitle: (r, d) => (r.role === 'operator' ? `${roleLabel.operator} · ${carrierName(d, r.carrierId)}` : roleLabel[r.role as 'admin']),
    columns: [
      { label: 'სახელი', render: (r) => <span className="font-medium text-slate-900">{r.firstName} {r.lastName}</span> },
      { label: 'როლი', render: (r) => <Badge tone={r.role === 'admin' ? 'violet' : r.role === 'operator' ? 'blue' : 'green'}>{roleLabel[r.role as 'admin']}</Badge> },
      { label: 'კარიერი', render: (r, d) => (r.carrierId ? carrierName(d, r.carrierId) : '—') },
      { label: 'ელ-ფოსტა', render: (r) => r.email },
      { label: 'ტელეფონი', render: (r) => r.phone },
    ],
  },
]

export function ReferenceData() {
  const d = useDb()
  const toast = useToast()
  const [tabKey, setTabKey] = useState<RefCollection | 'cargo'>('carriers')
  const isCargo = tabKey === 'cargo'
  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[0]
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Rec | null>(null)
  const [deleting, setDeleting] = useState<Rec | null>(null)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => {
    const list = d[tab.key] as unknown as Rec[]
    const n = q.trim().toLowerCase()
    const text = (r: Rec) => [...Object.values(r).filter((v) => typeof v === 'string'), ...destsOf(r).flatMap((x) => [x.address, x.scaleId])]
    return n ? list.filter((r) => text(r).some((v) => v.toLowerCase().includes(n))) : list
  }, [d, tab.key, q])

  const blank = (): Rec => {
    const r: Rec = { id: '' }
    tab.fields.forEach((f) => (r[f.key] = f.type === 'select' ? (f.options!(d)[0]?.value ?? '') : ''))
    if (tab.key === 'carriers') Object.assign(r, { destinations: [{ id: '', address: '', scaleId: '' }] })
    return r
  }

  const doDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await refs.remove(tab.key, deleting.id)
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
        subtitle="კარიერები, მძღოლები, მანქანები, მომხმარებლები და ტვირთი."
        actions={
          !isCargo && (
            <span className="hidden sm:block">
              <Button icon={<Plus className="size-4" />} onClick={() => setEditing(blank())}>
                {tab.singular} დამატება
              </Button>
            </span>
          )
        }
      />

      <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:inline-flex sm:max-w-full sm:rounded-[9px] sm:bg-fill sm:p-[2px]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTabKey(t.key)
              setQ('')
            }}
            className={cx(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-all duration-200 sm:h-7 sm:rounded-[7px]',
              tabKey === t.key ? 'bg-brand-600 font-semibold text-white sm:bg-white sm:text-slate-900 sm:shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] sm:dark:bg-slate-400' : 'bg-surface font-medium text-slate-600 sm:bg-transparent',
            )}
          >
            <t.icon className="size-4" />
            {t.label}
            <span className="rounded-md bg-slate-200/70 px-1.5 text-[11px] text-slate-600 tabular-nums">{(d[t.key] as unknown[]).length}</span>
          </button>
        ))}
        <button
          onClick={() => setTabKey('cargo')}
          className={cx(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-all duration-200 sm:h-7 sm:rounded-[7px]',
            isCargo ? 'bg-brand-600 font-semibold text-white sm:bg-white sm:text-slate-900 sm:shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] sm:dark:bg-slate-400' : 'bg-surface font-medium text-slate-600 sm:bg-transparent',
          )}
        >
          <Package className="size-4" />
          ტვირთი
        </button>
      </div>

      {isCargo && <CargoDefaultsCard />}

      <div className={cx('mb-4 flex gap-2', isCargo && 'hidden')}>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ძებნა…" className="pl-9" />
        </div>
        <span className="sm:hidden">
          <Button className="w-11 px-0" icon={<Plus className="size-4" />} onClick={() => setEditing(blank())} aria-label={`${tab.singular} დამატება`} />
        </span>
      </div>

      <Card className={cx('overflow-hidden', isCargo && 'hidden')}>
        {rows.length === 0 ? (
          <EmptyState icon={<tab.icon className="size-6" />} title="ჩანაწერები ვერ მოიძებნა" />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-separator text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                    {tab.columns.map((c) => (
                      <th key={c.label} className="px-5 py-3 first:pl-5">
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
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
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
        busy={busy}
        title={`${tab.singular} წაშლა?`}
        message={
          deleting && (
            <>
              <b className="text-slate-900">{tab.title(deleting, d)}</b> სამუდამოდ წაიშლება.
              {refs.usage(tab.key, deleting.id) && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-amber-800">ყურადღება: {refs.usage(tab.key, deleting.id)} წაშლა დაიბლოკება.</p>}
            </>
          )
        }
      />
    </>
  )
}

/** The cargo and declared quantity stamped on every new shipment. Free text, set by the admin. */
function CargoDefaultsCard() {
  const d = useDb()
  const user = useUser()
  const toast = useToast()
  const [form, setForm] = useState({
    description: d.cargo.description,
    code: d.cargo.code,
    whsCode: d.cargo.whsCode,
    quantity: String(d.cargo.quantity),
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const dirty = form.description.trim() !== d.cargo.description || form.code.trim() !== d.cargo.code || form.whsCode.trim() !== d.cargo.whsCode || Number(form.quantity) !== d.cargo.quantity

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!form.description.trim()) errs.description = 'სავალდებულო ველი'
    const q = Number(form.quantity)
    if (!form.quantity || !(q > 0) || q > 60) errs.quantity = 'შეიყვანე რაოდენობა 0-დან 60 ტ-მდე'
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true)
    try {
      await cargo.save(
        {
          description: form.description,
          code: form.code,
          whsCode: form.whsCode,
          quantity: q,
        },
        user,
      )
      toast('success', 'ტვირთი შენახულია')
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <Lock className="size-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">ტვირთი ყველა რეისისთვის</h3>
          <p className="text-xs text-slate-500">ავტომატურად ემატება ყველა ახალ რეისს — ოპერატორი ამას ვერ ცვლის. უკვე შექმნილი რეისები არ იცვლება.</p>
        </div>
      </div>
      <form onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2">
          <Field label="ტვირთის დასახელება" error={errors.description}>
            <Input value={form.description} placeholder="მაგ. ღორღი 0–5 მმ" invalid={!!errors.description} onChange={set('description')} />
          </Field>
        </div>
        <Field label="დეკლარირებული რაოდენობა (ტ)" error={errors.quantity}>
          <Input type="number" inputMode="decimal" step="0.1" min="0" value={form.quantity} invalid={!!errors.quantity} onChange={set('quantity')} />
        </Field>
        <Field label="ტვირთის კოდი (არასავალდებულო)">
          <Input value={form.code} placeholder="CRS-05" className="font-mono" onChange={set('code')} />
        </Field>
        <Field label="საწყობის კოდი (არასავალდებულო)">
          <Input value={form.whsCode} placeholder="WH-01" className="font-mono" onChange={set('whsCode')} />
        </Field>
        <div className="flex items-end justify-end sm:col-span-2">
          <Button type="submit" loading={busy} disabled={!dirty}>
            შენახვა
          </Button>
        </div>
      </form>
    </Card>
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
  const [r, setR] = useState<Rec>(rec)
  const hasDests = tab.key === 'carriers'
  const [dests, setDests] = useState<Destination[]>(() => destsOf(rec).map((x) => ({ ...x })))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const isNew = !rec.id

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const errs: Record<string, string> = {}
    for (const f of tab.fields) {
      if (f.showIf && !f.showIf(r)) continue
      const v = (r[f.key] ?? '').trim()
      if (!v) {
        if (!f.optional) errs[f.key] = 'სავალდებულო ველი'
        continue
      }
      const msg = f.validate?.(v, r)
      if (msg) errs[f.key] = msg
    }
    if (hasDests) {
      if (!dests.length) errs.destinations = 'დაამატე მინიმუმ ერთი დასრულების მისამართი'
      const seen = new Set<string>()
      dests.forEach((x, i) => {
        if (!x.address.trim()) errs[`dest.${i}.address`] = 'სავალდებულო ველი'
        const sid = x.scaleId.trim().toUpperCase()
        if (!sid) errs[`dest.${i}.scaleId`] = 'სავალდებულო ველი'
        else if (seen.has(sid)) errs[`dest.${i}.scaleId`] = 'სასწორის ID მეორდება'
        seen.add(sid)
      })
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true)
    try {
      const clean: Rec = { id: r.id }
      for (const f of tab.fields) {
        if (f.showIf && !f.showIf(r)) continue
        let v = (r[f.key] ?? '').trim()
        if (f.key === 'plateNumber' || f.key === 'trailerNumber') v = v.toUpperCase()
        clean[f.key] = v
      }
      if (hasDests) Object.assign(clean, { destinations: dests.map((x) => ({ id: x.id, address: x.address.trim(), scaleId: x.scaleId.trim().toUpperCase() })) })
      await refs.save(tab.key, clean as never)
      toast('success', isNew ? 'ჩანაწერი დაემატა' : 'ცვლილებები შენახულია')
      onClose()
    } catch (err) {
      toast('error', (err as Error).message)
      setBusy(false)
    }
  }

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
        {tab.fields
          .filter((f) => !f.showIf || f.showIf(r))
          .map((f) => (
            <div key={f.key} className={cx(tab.fields.length % 2 === 1 && f === tab.fields[0] && 'sm:col-span-2')}>
              <Field label={f.label + (f.optional ? ' (არასავალდებულო)' : '')} error={errors[f.key]}>
                {f.type === 'select' ? (
                  <Select value={r[f.key] ?? ''} onChange={(e) => setR((x) => ({ ...x, [f.key]: e.target.value, ...(f.key === 'role' && e.target.value === 'operator' && !x.carrierId ? { carrierId: d.carriers[0]?.id } : {}) }))} invalid={!!errors[f.key]}>
                    {f.options!(d).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    type={f.type ?? 'text'}
                    value={r[f.key] ?? ''}
                    placeholder={f.placeholder}
                    inputMode={f.key === 'personalId' ? 'numeric' : undefined}
                    className={f.mono ? 'font-mono' : undefined}
                    invalid={!!errors[f.key]}
                    onChange={(e) => {
                      setR((x) => ({ ...x, [f.key]: e.target.value }))
                      setErrors((x) => ({ ...x, [f.key]: '' }))
                    }}
                  />
                )}
              </Field>
            </div>
          ))}
        {hasDests && (
          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">დასრულების მისამართები</span>
              <Button type="button" variant="secondary" size="sm" icon={<Plus className="size-4" />} onClick={() => setDests((xs) => [...xs, { id: '', address: '', scaleId: '' }])}>
                დამატება
              </Button>
            </div>
            {errors.destinations && <p className="mb-2 text-xs text-rose-600">{errors.destinations}</p>}
            <div className="space-y-3">
              {dests.map((x, i) => {
                const upd = (k: 'address' | 'scaleId', v: string) => {
                  setDests((xs) => xs.map((y, j) => (j === i ? { ...y, [k]: v } : y)))
                  setErrors((e) => ({ ...e, [`dest.${i}.${k}`]: '', destinations: '' }))
                }
                return (
                  <div key={i} className="flex items-start gap-2">
                    <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
                      <Field label={`მისამართი ${i + 1}`} error={errors[`dest.${i}.address`]}>
                        <Input value={x.address} placeholder="ჩაბარების პუნქტი" invalid={!!errors[`dest.${i}.address`]} onChange={(e) => upd('address', e.target.value)} />
                      </Field>
                      <Field label="სასწორის ID" error={errors[`dest.${i}.scaleId`]}>
                        <Input value={x.scaleId} placeholder="SCALE-06" className="font-mono" invalid={!!errors[`dest.${i}.scaleId`]} onChange={(e) => upd('scaleId', e.target.value)} />
                      </Field>
                    </div>
                    <button
                      type="button"
                      disabled={dests.length === 1}
                      onClick={() => {
                        setDests((xs) => xs.filter((_, j) => j !== i))
                        setErrors({})
                      }}
                      className="mt-7 rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:pointer-events-none disabled:opacity-30"
                      aria-label="მისამართის წაშლა"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  )
}

