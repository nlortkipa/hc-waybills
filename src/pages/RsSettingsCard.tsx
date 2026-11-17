import { AlertTriangle, CheckCircle2, FileText, PlugZap, Search } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { cargo, rsSettings } from '../api'
import { useDb } from '../api/store'
import { Button, Card, Field, Input, Select, Toggle } from '../components/ui'
import { useToast } from '../components/toast'
import { RS_TRANS_OTHER, RS_UNIT_OTHER, RS_VAT_TYPES, rsMissing } from '../lib/rs'
import { formatDateTime } from '../lib/util'
import type { CargoDefaults, RsSettings } from '../types'

type Form = Record<'su' | 'sp' | 'buyerTin' | 'buyerName' | 'transporterTin' | 'transId' | 'transTxt' | 'tranCostPayer' | 'transportCost' | 'unitId' | 'unitTxt' | 'price' | 'vatType' | 'receptionInfo' | 'receiverInfo' | 'comment' | 'cargoDescription' | 'cargoCode' | 'cargoQuantity', string> & {
  buyerForeign: boolean
}

const toForm = (rs: RsSettings, c: CargoDefaults): Form => ({
  cargoDescription: c.description,
  cargoCode: c.code,
  cargoQuantity: c.quantity ? String(c.quantity) : '',
  su: rs.su,
  sp: '',
  buyerTin: rs.buyerTin,
  buyerName: rs.buyerName,
  buyerForeign: rs.buyerForeign,
  transporterTin: rs.transporterTin,
  transId: String(rs.transId),
  transTxt: rs.transTxt,
  tranCostPayer: String(rs.tranCostPayer),
  transportCost: String(rs.transportCost),
  unitId: String(rs.unitId),
  unitTxt: rs.unitTxt,
  price: String(rs.price),
  vatType: String(rs.vatType),
  receptionInfo: rs.receptionInfo,
  receiverInfo: rs.receiverInfo,
  comment: rs.comment,
})

/** Used until "check connection" loads the real lists from RS.ge. */
const FALLBACK_TRANS = [
  { id: 1, name: 'საავტომობილო' },
  { id: RS_TRANS_OTHER, name: 'სხვა' },
]
const FALLBACK_UNITS = [{ id: RS_UNIT_OTHER, name: 'სხვა' }]

/** RS.ge waybill settings and the cargo, applied to every new shipment. Admin only. */
export function RsSettingsCard() {
  const d = useDb()
  const rs = d.rs
  const toast = useToast()
  const [f, setF] = useState<Form>(() => toForm(rs, d.cargo))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'' | 'save' | 'check' | 'name'>('')

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }
  const orig = toForm(rs, d.cargo)
  const cargoDirty = f.cargoDescription.trim() !== orig.cargoDescription || f.cargoCode.trim() !== orig.cargoCode || Number(f.cargoQuantity) !== d.cargo.quantity
  const dirty = (Object.keys(f) as (keyof Form)[]).some((k) => (k === 'sp' ? !!f.sp : String(f[k]).trim() !== String(orig[k])))

  const units = rs.units.some((u) => u.id === RS_UNIT_OTHER) ? rs.units : [...rs.units, ...FALLBACK_UNITS]
  const transTypes = rs.transTypes.length ? rs.transTypes : FALLBACK_TRANS
  const missing = [
    ...(!d.cargo.description ? ['ტვირთის დასახელება'] : []),
    ...(!d.cargo.code ? ['ტვირთის კოდი'] : []),
    ...(!(d.cargo.quantity > 0) ? ['რაოდენობა'] : []),
    ...rsMissing(rs, { hasCreds: !!rs.su && !!rs.spSet }),
  ]
  /** Credentials to test with: typed ones, or the stored ones when left empty. */
  const typedCreds = () => ({ su: f.su.trim() || undefined, sp: f.sp.trim() || undefined })

  const validate = () => {
    const e: Record<string, string> = {}
    if (!f.cargoDescription.trim()) e.cargoDescription = 'სავალდებულო ველი'
    if (!f.cargoCode.trim()) e.cargoCode = 'სავალდებულო ველი'
    if (!(Number(f.cargoQuantity) > 0)) e.cargoQuantity = 'შეიყვანე 0-ზე მეტი რაოდენობა'
    const tin = f.buyerTin.trim()
    if (!tin) e.buyerTin = 'სავალდებულო ველი'
    else if (!f.buyerForeign && !/^\d{9}$|^\d{11}$/.test(tin)) e.buyerTin = '9 ან 11 ციფრი'
    if (!f.buyerName.trim()) e.buyerName = 'სავალდებულო ველი'
    if (f.transporterTin.trim() && !/^\d{9}$|^\d{11}$/.test(f.transporterTin.trim())) e.transporterTin = '9 ან 11 ციფრი'
    if (Number(f.unitId) === RS_UNIT_OTHER && !f.unitTxt.trim()) e.unitTxt = 'სავალდებულო ველი'
    if (Number(f.transId) === RS_TRANS_OTHER && !f.transTxt.trim()) e.transTxt = 'სავალდებულო ველი'
    if (f.price === '' || !(Number(f.price) >= 0)) e.price = 'შეიყვანე 0 ან მეტი'
    if (f.transportCost !== '' && !(Number(f.transportCost) >= 0)) e.transportCost = 'შეიყვანე 0 ან მეტი'
    if (!f.su.trim()) e.su = 'სავალდებულო ველი'
    if (!f.sp && !(rs.spSet && f.su.trim() === rs.su)) e.sp = 'სავალდებულო ველი'
    setErrors(e)
    return !Object.keys(e).length
  }

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!validate()) return
    setBusy('save')
    try {
      if (cargoDirty) await cargo.save({ description: f.cargoDescription, code: f.cargoCode, quantity: Number(f.cargoQuantity) })
      await rsSettings.save({
        ...f,
        transId: Number(f.transId),
        tranCostPayer: Number(f.tranCostPayer) as 1 | 2,
        transportCost: Number(f.transportCost || 0),
        unitId: Number(f.unitId),
        price: Number(f.price),
        vatType: Number(f.vatType) as 0 | 1 | 2,
      })
      setF((x) => ({ ...x, sp: '' }))
      toast('success', 'პარამეტრები შენახულია')
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const check = async () => {
    setBusy('check')
    try {
      const r = await rsSettings.check(typedCreds())
      // The server stores a service user that passed the check.
      setF((x) => ({ ...x, sp: '' }))
      toast('success', `კავშირი წარმატებულია და მომხმარებელი შენახულია: ${r.name} (${r.tin})`)
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const lookupBuyer = async () => {
    if (!f.buyerTin.trim()) return setErrors((x) => ({ ...x, buyerTin: 'ჯერ შეიყვანე ნომერი' }))
    setBusy('name')
    try {
      const { name } = await rsSettings.nameFromTin(f.buyerTin.trim(), typedCreds())
      // Only the name: being in RS.ge's register says nothing certain about citizenship, so the toggle stays as set.
      setF((x) => ({ ...x, buyerName: name }))
      setErrors((x) => ({ ...x, buyerTin: '', buyerName: '' }))
    } catch (err) {
      // Leave the name as it was; show why next to the number.
      setErrors((x) => ({ ...x, buyerTin: (err as Error).message }))
    } finally {
      setBusy('')
    }
  }

  return (
    <form onSubmit={save} className="space-y-4" noValidate>
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
          <p>ყველაფერი შევსებულია — ზედნადებები იტვირთება RS.ge-ზე ამ სერვისის მომხმარებლით.</p>
        </div>
      )}

      <Section icon={<PlugZap className="size-4" />} title="კავშირი RS.ge-სთან" text="სერვისის მომხმარებელი იქმნება eservices.rs.ge-ზე. RS.ge-ს ცალკე სატესტო სერვერი არ აქვს — ამ მომხმარებლით შექმნილი ზედნადებები მის მფლობელზე იწერება. პაროლი ინახება მხოლოდ სერვერზე.">
        <Field label="სერვისის მომხმარებელი (su)" error={errors.su} hint="ფორმატი: სახელი:საიდენტიფიკაციო. სატესტო: YVELAM GAMOIYENET:12345678910 / 123456">
          <Input value={f.su} autoComplete="off" className="font-mono" placeholder="NAME:206322102" invalid={!!errors.su} onChange={set('su')} />
        </Field>
        <Field label="სერვისის პაროლი (sp)" error={errors.sp} hint={rs.spSet && !f.sp ? 'შენახულია — დატოვე ცარიელი, თუ არ ცვლი' : undefined}>
          <Input type="password" value={f.sp} autoComplete="new-password" placeholder={rs.spSet ? '••••••' : ''} invalid={!!errors.sp} onChange={set('sp')} />
        </Field>
        <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <span className="text-slate-500">გამყიდველი: </span>
            {rs.sellerUnId ? (
              <span className="text-slate-900">
                {rs.sellerName} <span className="font-mono text-[13px]">({rs.sellerTin})</span>
                <span className="text-slate-400"> · შემოწმდა {formatDateTime(rs.checkedAt)}</span>
              </span>
            ) : (
              <span className="text-slate-400">დადგინდება კავშირის შემოწმებით ან პირველი ატვირთვისას</span>
            )}
          </div>
          <Button type="button" variant="secondary" size="sm" loading={busy === 'check'} disabled={!!busy} onClick={() => void check()} icon={<PlugZap className="size-3.5" />}>
            კავშირის შემოწმება
          </Button>
        </div>
      </Section>

      <Section title="მყიდველი" text="ვის მიეწოდება ტვირთი. ერთი და იგივე ყველა რეისზე. სატესტოდ შეგიძლია გამოიყენო 12345678910.">
        <Field label="საიდენტიფიკაციო / პირადი ნომერი" error={errors.buyerTin}>
          <div className="flex gap-2">
            <Input value={f.buyerTin} inputMode={f.buyerForeign ? 'text' : 'numeric'} className="font-mono" invalid={!!errors.buyerTin} onChange={set('buyerTin')} />
            <Button type="button" variant="secondary" className="shrink-0" loading={busy === 'name'} disabled={!!busy} onClick={() => void lookupBuyer()} icon={<Search className="size-4" />} title="დასახელების მოძებნა RS.ge-ზე">
              <span className="sm:hidden lg:inline">მოძებნა</span>
            </Button>
          </div>
        </Field>
        <Field label="დასახელება" error={errors.buyerName}>
          <Input value={f.buyerName} invalid={!!errors.buyerName} onChange={set('buyerName')} />
        </Field>
        <div className="sm:col-span-2">
          <Toggle checked={f.buyerForeign} onChange={(v) => setF((x) => ({ ...x, buyerForeign: v }))} label="მყიდველი უცხოელია" />
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
          <Field label="გადამზიდავი კომპანიის ს/ნ (არასავალდებულო)" error={errors.transporterTin} hint="შეავსე მხოლოდ მაშინ, თუ ტრანსპორტირებას სხვა კომპანია ახორციელებს — RS.ge-ზე ზედნადებს ის გააქტიურებს.">
            <Input value={f.transporterTin} inputMode="numeric" className="font-mono" invalid={!!errors.transporterTin} onChange={set('transporterTin')} />
          </Field>
        </div>
      </Section>

      <Section title="ტვირთი" text="ავტომატურად ემატება ყველა ახალ რეისს — ოპერატორი ამას ვერ ცვლის. უკვე შექმნილი რეისები არ იცვლება.">
        <div className="sm:col-span-2">
          <Field label="ტვირთის დასახელება" error={errors.cargoDescription}>
            <Input value={f.cargoDescription} placeholder="მაგ. ღორღი 0–5 მმ" invalid={!!errors.cargoDescription} onChange={set('cargoDescription')} />
          </Field>
        </div>
        <Field label="დეკლარირებული რაოდენობა (ტ)" error={errors.cargoQuantity}>
          <Input type="number" inputMode="decimal" step="0.1" min="0" value={f.cargoQuantity} invalid={!!errors.cargoQuantity} onChange={set('cargoQuantity')} />
        </Field>
        <Field label="ტვირთის კოდი (შტრიხკოდი)" error={errors.cargoCode}>
          <Input value={f.cargoCode} placeholder="CRS-05" className="font-mono" invalid={!!errors.cargoCode} onChange={set('cargoCode')} />
        </Field>
        <Field label="საზომი ერთეული">
          <Select value={f.unitId} onChange={set('unitId')}>
            {units.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        {Number(f.unitId) === RS_UNIT_OTHER ? (
          <Field label="ერთეულის დასახელება" error={errors.unitTxt}>
            <Input value={f.unitTxt} placeholder="ტონა" invalid={!!errors.unitTxt} onChange={set('unitTxt')} />
          </Field>
        ) : (
          <div className="hidden sm:block" />
        )}
        <Field label="ერთეულის ფასი (₾)" error={errors.price} hint={Number(f.price) >= 0 && Number(f.cargoQuantity) > 0 ? `ჯამი რეისზე: ${(Number(f.price) * Number(f.cargoQuantity)).toFixed(2)} ₾` : undefined}>
          <Input type="number" inputMode="decimal" min="0" step="0.01" value={f.price} invalid={!!errors.price} onChange={set('price')} />
        </Field>
        <Field label="დაბეგვრის ტიპი">
          <Select value={f.vatType} onChange={set('vatType')}>
            {RS_VAT_TYPES.map((v) => (
              <option key={v.value} value={String(v.value)}>
                {v.label}
              </option>
            ))}
          </Select>
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
        <Button type="submit" loading={busy === 'save'} disabled={!dirty || (!!busy && busy !== 'save')}>
          შენახვა
        </Button>
      </div>
    </form>
  )
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
