import { AlertTriangle, CheckCircle2, FileText, Loader2, PlugZap, RefreshCw, Unplug, XCircle } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { rsSettings } from '../api'
import { useDb } from '../api/store'
import { Button, Card, ConfirmModal, Field, Input, PageHeader, Select } from '../components/ui'
import { useToast } from '../components/toast'
import { isInternal, RS_TRANS_OTHER, rsMissing } from '../lib/rs'
import { active, formatDateTime } from '../lib/util'
import type { RsSettings } from '../types'

type Form = Record<'buyerTin' | 'buyerName' | 'transporterTin' | 'transId' | 'transTxt' | 'tranCostPayer' | 'transportCost' | 'quantity' | 'receptionInfo' | 'receiverInfo' | 'comment', string>

const toForm = (rs: RsSettings): Form => ({
  quantity: rs.quantity ? String(rs.quantity) : '',
  buyerTin: rs.buyerTin,
  // Only a name RS.ge doesn't have is the admin's; RS.ge's own is shown from the lookup.
  buyerName: rs.buyerForeign ? rs.buyerName : '',
  transporterTin: rs.transporterTin,
  transId: String(rs.transId),
  transTxt: rs.transTxt,
  tranCostPayer: String(rs.tranCostPayer),
  transportCost: String(rs.transportCost),
  receptionInfo: rs.receptionInfo,
  receiverInfo: rs.receiverInfo,
  comment: rs.comment,
})

/** Used until the connection loads the real lists from RS.ge. */
const FALLBACK_TRANS = [
  { id: 1, name: 'საავტომობილო' },
  { id: RS_TRANS_OTHER, name: 'სხვა' },
]

/** Georgian tax ID: 9 digits (company) or 11 (personal number). */
const TIN_RE = /^\d{9}$|^\d{11}$/

const isConnected = (rs: RsSettings) => !!rs.su && !!rs.spSet && !!rs.sellerUnId

/* ------------------------------ Name lookup ------------------------------ */

/** `missing`: a foreign number RS.ge doesn't know — its name is typed by hand. */
type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; name: string } | { state: 'missing' } | { state: 'error'; message: string }

/** Names already looked up in this session, so re-renders and remounts don't ask RS.ge again. */
const nameCache = new Map<string, string>()

/**
 * Looks the taxpayer's name up on RS.ge as soon as `tin` is complete: a full Georgian number, or
 * any foreign number. A stored name is never trusted: it may have been typed by hand.
 */
function useTinName(tin: string, enabled: boolean, foreign = false): Lookup {
  const [res, setRes] = useState<{ key: string; lookup: Lookup }>({ key: '', lookup: { state: 'idle' } })
  const valid = enabled && (foreign ? tin !== '' : TIN_RE.test(tin))
  const key = `${foreign}:${tin}`
  const preset = nameCache.get(tin)
  useEffect(() => {
    if (!valid || preset) return
    let gone = false
    const t = setTimeout(() => {
      rsSettings.nameFromTin(tin, foreign).then(
        ({ name }) => {
          if (name) nameCache.set(tin, name)
          if (!gone) setRes({ key, lookup: name ? { state: 'ok', name } : { state: 'missing' } })
        },
        (e: Error) => !gone && setRes({ key, lookup: { state: 'error', message: e.message } }),
      )
    }, 300)
    return () => {
      gone = true
      clearTimeout(t)
    }
  }, [tin, foreign, key, valid, preset])
  if (!valid) return { state: 'idle' }
  if (preset) return { state: 'ok', name: preset }
  return res.key === key ? res.lookup : { state: 'loading' }
}

function LookupLine({ lookup }: { lookup: Lookup }) {
  if (lookup.state === 'idle') return null
  return (
    <p className="mt-1 ml-1 flex items-center gap-1.5 text-xs">
      {lookup.state === 'loading' && (
        <>
          <Loader2 className="size-3.5 animate-spin text-slate-400" />
          <span className="text-slate-500">RS.ge-ზე მოწმდება…</span>
        </>
      )}
      {lookup.state === 'missing' && <span className="text-slate-500">RS.ge-ზე ვერ მოიძებნა — დასახელება შეიყვანე ხელით</span>}
      {lookup.state === 'ok' && (
        <>
          <CheckCircle2 className="size-3.5 text-emerald-500" />
          <span className="text-slate-900">{lookup.name}</span>
        </>
      )}
      {lookup.state === 'error' && (
        <>
          <XCircle className="size-3.5 text-rose-500" />
          <span className="text-rose-600">{lookup.message}</span>
        </>
      )}
    </p>
  )
}

/* ------------------------------- Screen ------------------------------- */

/** RS.ge: the service user (connected once) and the waybill defaults applied to every new shipment. Admin only. */
export function RsSettings() {
  const d = useDb()
  const connected = isConnected(d.rs)
  const missing = [...rsMissing(d.rs, { hasCreds: connected }), ...(!active(d.products).length ? ['პროდუქტი (ცნობარები → პროდუქტები)'] : [])]

  return (
    <>
      <PageHeader title="RS.ge" subtitle="სერვისის მომხმარებელი, მყიდველი და ზედნადების პარამეტრები. პროდუქტები — ცნობარებში." />
      <div className="space-y-4">
        {missing.length > 0 ? (
          <div className="flex gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium">ზედნადებები ვერ აიტვირთება, სანამ არ შეივსება:</p>
              <p className="mt-1 text-amber-800">{missing.join(' · ')}</p>
            </div>
          </div>
        ) : (
          <div className="flex gap-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900 ring-1 ring-emerald-200">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <p>ყველაფერი შევსებულია — ზედნადებები იტვირთება RS.ge-ზე.</p>
          </div>
        )}
        <ConnectionCard />
        <DefaultsForm connected={connected} />
      </div>
    </>
  )
}

/* ------------------------------ Connection ------------------------------ */

/** RS.ge service user names are "<name>:<taxpayer id>"; the form asks for the two parts separately. */
function splitSu(su: string) {
  const i = su.lastIndexOf(':')
  return i < 0 ? { name: su, id: '' } : { name: su.slice(0, i), id: su.slice(i + 1) }
}

function ConnectionCard() {
  const rs = useDb().rs
  const toast = useToast()
  const connected = isConnected(rs)
  const [editing, setEditing] = useState(false)
  const [suName, setSuName] = useState(() => splitSu(rs.su).name)
  const [suId, setSuId] = useState(() => splitSu(rs.su).id)
  const [sp, setSp] = useState('')
  const [errors, setErrors] = useState<{ suName?: string; suId?: string; sp?: string }>({})
  const su = `${suName.trim()}:${suId.trim()}`
  const [busy, setBusy] = useState(false)
  const [askDisconnect, setAskDisconnect] = useState(false)
  /** The stored password can be re-used while the user name stays the same. */
  const keepsPassword = !!rs.spSet && su === rs.su
  const setUser = (part: 'suName' | 'suId', set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value)
    setErrors((x) => ({ ...x, [part]: '' }))
  }

  const connect = async (e: FormEvent) => {
    e.preventDefault()
    const id = suId.trim()
    const errs = {
      suName: !suName.trim() ? 'სავალდებულო ველი' : suName.includes(':') ? 'სახელში „:“ არ უნდა იყოს' : '',
      suId: !id ? 'სავალდებულო ველი' : /^\d{9}$|^\d{11}$/.test(id) ? '' : 'უნდა იყოს 9 ან 11 ციფრი',
      sp: sp || keepsPassword ? '' : 'სავალდებულო ველი',
    }
    setErrors(errs)
    if (errs.suName || errs.suId || errs.sp) return
    setBusy(true)
    try {
      const r = await rsSettings.connect({ su, sp: sp || undefined })
      setSp('')
      setEditing(false)
      toast('success', `დაკავშირებულია: ${r.name} (${r.tin})`)
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await rsSettings.disconnect()
      setSuName('')
      setSuId('')
      setSp('')
      setAskDisconnect(false)
      toast('success', 'RS.ge-სთან კავშირი გაითიშა')
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (connected && !editing) {
    return (
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
              <CheckCircle2 className="size-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900">დაკავშირებულია RS.ge-სთან</h3>
              <p className="text-sm text-slate-900">
                {rs.sellerName} <span className="font-mono text-[13px] text-slate-500">({rs.sellerTin})</span>
              </p>
              <p className="text-xs text-slate-500">
                სერვისის მომხმარებელი <span className="font-mono">{rs.su}</span>
                {rs.checkedAt && <> · შემოწმდა {formatDateTime(rs.checkedAt)}</>}
              </p>
              <SyncLine rs={rs} />
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setSuName(splitSu(rs.su).name)
                setSuId(splitSu(rs.su).id)
                setSp('')
                setErrors({})
                setEditing(true)
              }}
            >
              შეცვლა
            </Button>
            <Button type="button" variant="ghost" size="sm" icon={<Unplug className="size-3.5" />} onClick={() => setAskDisconnect(true)}>
              გათიშვა
            </Button>
          </div>
        </div>
        <ConfirmModal
          open={askDisconnect}
          title="RS.ge-სთან კავშირის გათიშვა"
          message="სერვისის მომხმარებელი წაიშლება და ახალი ზედნადებები ვერ აიტვირთება, სანამ თავიდან არ დაუკავშირდები. RS.ge-ზე უკვე ატვირთული ზედნადებები არ შეიცვლება."
          confirmLabel="გათიშვა"
          busy={busy}
          onConfirm={() => void disconnect()}
          onClose={() => setAskDisconnect(false)}
        />
      </Card>
    )
  }

  return (
    <form onSubmit={connect} noValidate>
      <Section
        icon={<PlugZap className="size-4" />}
        title="დაკავშირება RS.ge-სთან"
        text="შეიყვანე სერვისის მომხმარებელი (ფორმატით სახელი:კოდი, ორ ველად) — იქმნება eservices.rs.ge-ზე (მომხმარებლები → სერვისის მომხმარებლები). შენახვამდე RS.ge-ზე შემოწმდება. პაროლი ინახება მხოლოდ სერვერზე."
      >
        <Field label="სერვისის მომხმარებლის სახელი" error={errors.suName} hint={import.meta.env.DEV ? 'სატესტო: YVELAM GAMOIYENET' : 'რაც „:“-მდე წერია'}>
          <Input value={suName} autoComplete="off" className="font-mono" placeholder="NAME" invalid={!!errors.suName} onChange={setUser('suName', setSuName)} />
        </Field>
        <Field label="საიდენტიფიკაციო კოდი" error={errors.suId} hint={import.meta.env.DEV ? 'სატესტო: 12345678910' : 'რაც „:“-ის შემდეგ წერია (9 ან 11 ციფრი)'}>
          <Input value={suId} inputMode="numeric" autoComplete="off" className="font-mono" placeholder="206322102" invalid={!!errors.suId} onChange={setUser('suId', setSuId)} />
        </Field>
        <Field label="პაროლი" error={errors.sp} hint={keepsPassword && !sp ? 'შენახულია — დატოვე ცარიელი, თუ არ ცვლი' : import.meta.env.DEV ? 'სატესტო: 123456' : undefined}>
          <Input
            type="password"
            value={sp}
            autoComplete="new-password"
            placeholder={keepsPassword ? '••••••' : ''}
            invalid={!!errors.sp}
            onChange={(e) => {
              setSp(e.target.value)
              setErrors((x) => ({ ...x, sp: '' }))
            }}
          />
        </Field>
        <div className="flex justify-end gap-2 sm:col-span-2">
          {editing && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              გაუქმება
            </Button>
          )}
          <Button type="submit" loading={busy} icon={<PlugZap className="size-4" />}>
            დაკავშირება
          </Button>
        </div>
      </Section>
    </form>
  )
}

/* ------------------------------- Defaults ------------------------------- */

function DefaultsForm({ connected }: { connected: boolean }) {
  const d = useDb()
  const rs = d.rs
  const toast = useToast()
  const [f, setF] = useState<Form>(() => toForm(rs))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }
  const transporter = useTinName(f.transporterTin.trim(), connected)
  const buyerTin = f.buyerTin.trim()
  const internal = isInternal({ buyerTin, sellerTin: rs.sellerTin })
  // Any number: RS.ge's name when it knows it (not editable), else whatever the admin types.
  const buyer = useTinName(internal ? '' : buyerTin, connected, true)

  const orig = toForm(rs)
  const dirty = (Object.keys(f) as (keyof Form)[]).some((k) => String(f[k]).trim() !== String(orig[k]))

  const transTypes = rs.transTypes.length ? rs.transTypes : FALLBACK_TRANS

  const validate = () => {
    const e: Record<string, string> = {}
    if (!internal) {
      if (buyer.state === 'loading') e.buyerTin = 'დაელოდე, მოწმდება RS.ge-ზე'
      else if (buyer.state === 'error') e.buyerTin = buyer.message
      else if (buyer.state === 'missing' && !f.buyerName.trim()) e.buyerName = 'სავალდებულო ველი'
    }
    if (f.quantity !== '' && !(Number(f.quantity) >= 0)) e.quantity = 'შეიყვანე 0 ან მეტი'
    if (f.transporterTin.trim() && !TIN_RE.test(f.transporterTin.trim())) e.transporterTin = '9 ან 11 ციფრი'
    else if (transporter.state === 'error') e.transporterTin = transporter.message
    if (Number(f.transId) === RS_TRANS_OTHER && !f.transTxt.trim()) e.transTxt = 'სავალდებულო ველი'
    if (f.transportCost !== '' && !(Number(f.transportCost) >= 0)) e.transportCost = 'შეიყვანე 0 ან მეტი'
    setErrors(e)
    return !Object.keys(e).length
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    setBusy(true)
    try {
      await rsSettings.save({
        ...f,
        buyerTin,
        buyerName: buyer.state === 'ok' ? buyer.name : f.buyerName.trim(),
        transId: Number(f.transId),
        tranCostPayer: Number(f.tranCostPayer) as 1 | 2,
        transportCost: Number(f.transportCost || 0),
        quantity: Number(f.quantity || 0),
      })
      toast('success', 'პარამეტრები შენახულია')
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} noValidate>
      {!connected && <p className="mb-3 ml-1 text-sm text-slate-500">ჯერ დაუკავშირდი RS.ge-ს — ნომრების შემოწმება და ცნობარები მის გარეშე არ მუშაობს.</p>}
      <fieldset disabled={!connected} className="space-y-4 disabled:pointer-events-none disabled:opacity-50">
        <Section
          title="მყიდველი"
          text={
            internal
              ? 'იგზავნება შიდა გადაზიდვა: ტვირთი გადაადგილდება კომპანიის ობიექტებს შორის და მყიდველი თავად გამყიდველია. სხვა მყიდველისთვის ჩაწერე მისი ნომერი.'
              : 'ზედნადები იგზავნება როგორც მიწოდება ტრანსპორტირებით. ერთი და იგივე ყველა რეისზე.'
          }
        >
          <div>
            <Field label="საიდენტიფიკაციო / პირადი ნომერი (არასავალდებულო)" error={errors.buyerTin} hint={internal && !buyerTin ? 'ცარიელი — შიდა გადაზიდვა' : undefined}>
              <Input value={f.buyerTin} className="font-mono" invalid={!!errors.buyerTin} onChange={set('buyerTin')} />
            </Field>
            {!errors.buyerTin && (buyer.state === 'loading' || buyer.state === 'error') && <LookupLine lookup={buyer} />}
          </div>
          <div>
            {internal ? (
              <Field label="დასახელება">
                <FixedValue>{rs.sellerTin ? `${rs.sellerName} (გამყიდველი)` : <span className="text-slate-400">შეივსება RS.ge-სთან დაკავშირებისას</span>}</FixedValue>
              </Field>
            ) : buyer.state === 'missing' ? (
              <Field label="დასახელება" error={errors.buyerName} hint="RS.ge-ზე ვერ მოიძებნა — ჩაწერე ნებისმიერი დასახელება">
                <Input value={f.buyerName} invalid={!!errors.buyerName} onChange={set('buyerName')} />
              </Field>
            ) : (
              <Field label="დასახელება" hint={buyer.state === 'ok' ? 'RS.ge-ს რეესტრიდან — არ იცვლება' : undefined}>
                <FixedValue>
                  {buyer.state === 'ok' ? (
                    <>
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                      <span className="truncate">{buyer.name}</span>
                    </>
                  ) : (
                    <span className="text-slate-400">{buyer.state === 'loading' ? 'მოწმდება…' : '—'}</span>
                  )}
                </FixedValue>
              </Field>
            )}
          </div>
        </Section>

        <Section title="ტრანსპორტირება">
          <Field label="ტრანსპორტის ტიპი">
            <Select value={f.transId} onChange={set('transId')}>
              {transTypes.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          {Number(f.transId) === RS_TRANS_OTHER ? (
            <Field label="ტრანსპორტის ტიპის დასახელება" error={errors.transTxt}>
              <Input value={f.transTxt} invalid={!!errors.transTxt} onChange={set('transTxt')} />
            </Field>
          ) : (
            <div className="hidden sm:block" />
          )}
          <Field label="ტრანსპორტირების ღირებულება (₾)" error={errors.transportCost}>
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={f.transportCost} invalid={!!errors.transportCost} onChange={set('transportCost')} />
          </Field>
          <Field label="ტრანსპორტირების ხარჯს იხდის">
            <Select value={f.tranCostPayer} onChange={set('tranCostPayer')}>
              <option value="2">გამყიდველი</option>
              <option value="1">მყიდველი</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="გადამზიდავი კომპანიის ს/ნ (არასავალდებულო)" error={errors.transporterTin} hint={transporter.state === 'idle' ? 'შეავსე მხოლოდ მაშინ, თუ ტრანსპორტირებას სხვა კომპანია ახორციელებს — RS.ge-ზე ზედნადებს ის გააქტიურებს.' : undefined}>
              <Input value={f.transporterTin} inputMode="numeric" className="font-mono" invalid={!!errors.transporterTin} onChange={set('transporterTin')} />
            </Field>
            {!errors.transporterTin && <LookupLine lookup={transporter} />}
          </div>
        </Section>

        <Section title="რაოდენობა" text="პროდუქტები, მათი ფასი და დაბეგვრის ტიპი თითოეულ მარშრუტზე ცალკე მიეთითება (ცნობარები → მარშრუტები). რაოდენობას ოპერატორი რეისზე წერს.">
          <Field label="რაოდენობა ნაგულისხმევად (არასავალდებულო)" error={errors.quantity} hint="ახალ რეისზე თითოეულ პროდუქტს ეს რაოდენობა ჩაეწერება; ოპერატორს შეუძლია შეცვალოს.">
            <Input type="number" inputMode="decimal" step="0.1" min="0" value={f.quantity} invalid={!!errors.quantity} onChange={set('quantity')} />
          </Field>
        </Section>

        <Section icon={<FileText className="size-4" />} title="დამატებითი ინფორმაცია" text="არასავალდებულო. მისაბმელის ნომერი კომენტარს ავტომატურად ემატება.">
          <Field label="მიმწოდებლის ინფორმაცია">
            <Input value={f.receptionInfo} onChange={set('receptionInfo')} />
          </Field>
          <Field label="მიმღების ინფორმაცია">
            <Input value={f.receiverInfo} onChange={set('receiverInfo')} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="კომენტარი">
              <Input value={f.comment} onChange={set('comment')} />
            </Field>
          </div>
        </Section>

        <div className="flex justify-end">
          <Button type="submit" loading={busy} disabled={!dirty}>
            შენახვა
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

/** A value shown where an input would be, but not editable. */
function FixedValue({ children }: { children: ReactNode }) {
  return <div className="flex h-11 items-center gap-1.5 rounded-[10px] px-3 text-[16px] text-slate-900 ring-1 ring-slate-500/15 ring-inset sm:text-[15px]">{children}</div>
}

function Section({ title, text, icon, children }: { title: string; text?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        {icon && <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">{icon}</div>}
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {text && <p className="text-xs text-slate-500">{text}</p>}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </Card>
  )
}

/** Background sync with RS.ge: when it last read the changes, why it failed, and a "sync now" button. */
function SyncLine({ rs }: { rs: RsSettings }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await rsSettings.syncNow()
      toast('success', 'RS.ge-სთან სინქრონიზაცია დასრულდა')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
      {rs.syncError ? (
        <span className="text-amber-700">სინქრონიზაცია ვერ მოხერხდა: {rs.syncError}</span>
      ) : (
        <span className="text-slate-500">{rs.syncedTo ? `RS.ge-ს ცვლილებები წაკითხულია ${formatDateTime(rs.syncedTo)}-მდე` : 'RS.ge-ს ცვლილებები ჯერ არ წაკითხულა'}</span>
      )}
      <button type="button" onClick={() => void run()} disabled={busy} className="inline-flex items-center gap-1 font-medium text-brand-600 hover:text-brand-700 disabled:opacity-60">
        <RefreshCw className={busy ? 'size-3 animate-spin' : 'size-3'} />
        განახლება
      </button>
    </p>
  )
}
