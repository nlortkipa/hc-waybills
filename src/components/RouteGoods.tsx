/*
 * The goods lines of a route, as the admin sets them up: bar code, name and unit typed in (or filled
 * from the RS.ge product list with the search button, and then still editable; nothing is added to
 * RS.ge's list), plus the price and VAT type. The operator types only the quantities on each shipment.
 */
import { Plus, Search, X } from 'lucide-react'
import { Button, Field, Input, Select } from './ui'
import { active, cx, uid } from '../lib/util'
import { RS_UNIT_OTHER, RS_VAT_TYPES, rsUnits, tonneUnit } from '../lib/rs'
import type { Database, RouteGood } from '../types'

/** A goods line in the form: every value as typed. */
export interface GoodDraft {
  /** React key; stays the same while the form is open. */
  key: string
  /** RouteGood.id; '' for a new line (the server gives it one). */
  id: string
  /** The list product it was filled from; it no longer counts once the bar code is changed. */
  productId: string
  name: string
  barCode: string
  unitId: string
  unitTxt: string
  price: string
  vatType: string
  /** Excise code id; '' = not excise goods. aTitle shows a stored code RS.ge's list doesn't have (yet). */
  aId: string
  aTitle: string
}

export const blankGood = (d: Database): GoodDraft => ({
  key: uid('k'),
  id: '',
  productId: '',
  name: '',
  barCode: '',
  unitId: String(tonneUnit(d.rs)),
  unitTxt: 'ტონა',
  price: '',
  vatType: '0',
  aId: '',
  aTitle: '',
})

export const toDraft = (g: RouteGood): GoodDraft => ({
  key: uid('k'),
  id: g.id,
  productId: g.productId,
  name: g.name,
  barCode: g.barCode,
  unitId: String(g.unitId),
  unitTxt: g.unitTxt,
  price: String(g.price),
  vatType: String(g.vatType),
  aId: g.aId ? String(g.aId) : '',
  aTitle: g.aTitle ?? '',
})

const priceOf = (g: GoodDraft) => g.price.trim().replace(',', '.')

/** Errors by `${key}.${field}`; empty when every line is complete. */
export function checkGoods(goods: GoodDraft[]): Record<string, string> {
  const e: Record<string, string> = {}
  const seen = new Set<string>()
  for (const g of goods) {
    const at = (f: keyof GoodDraft) => `${g.key}.${f}`
    const code = g.barCode.trim().toLowerCase()
    // RS.ge requires a bar code, a name and a unit on every goods line.
    if (!code) e[at('barCode')] = 'სავალდებულო ველი'
    else if (seen.has(code)) e[at('barCode')] = 'ეს შტრიხკოდი მარშრუტზე უკვე არის'
    seen.add(code)
    if (!g.name.trim()) e[at('name')] = 'სავალდებულო ველი'
    if (Number(g.unitId) === RS_UNIT_OTHER && !g.unitTxt.trim()) e[at('unitTxt')] = 'სავალდებულო ველი'
    if (!priceOf(g) || !(Number(priceOf(g)) >= 0)) e[at('price')] = 'შეიყვანე 0 ან მეტი'
  }
  if (!goods.length) e.goods = 'დაამატე მინიმუმ ერთი პროდუქტი'
  return e
}

/** The lines as the server takes them. */
export function fromDrafts(d: Database, goods: GoodDraft[]) {
  const units = rsUnits(d.rs)
  return goods.map((g) => {
    const unitId = Number(g.unitId)
    return {
      id: g.id,
      productId: g.productId,
      name: g.name.trim(),
      barCode: g.barCode.trim(),
      unitId,
      unitTxt: unitId === RS_UNIT_OTHER ? g.unitTxt.trim() : (units.find((u) => u.id === unitId)?.name ?? g.unitTxt.trim()),
      price: Number(priceOf(g)),
      vatType: Number(g.vatType),
      aId: Number(g.aId || 0),
    }
  })
}

export function RouteGoodsEditor({ d, goods, onChange, errors, onClearError }: { d: Database; goods: GoodDraft[]; onChange: (g: GoodDraft[]) => void; errors: Record<string, string>; onClearError: (key: string) => void }) {
  const products = active(d.products)
  const units = rsUnits(d.rs)
  const set = (key: string, patch: Partial<GoodDraft>) => {
    onChange(goods.map((g) => (g.key === key ? { ...g, ...patch } : g)))
    for (const f of Object.keys(patch)) onClearError(`${key}.${f}`)
    onClearError('goods')
  }
  const akciz = d.rs.akciz ?? []
  /** Marks the line as excise goods. Its code, name and unit fill only the fields still empty. */
  const pickAkciz = (g: GoodDraft, id: string) => {
    const a = akciz.find((x) => String(x.id) === id)
    if (!a) return set(g.key, { aId: '', aTitle: '' })
    const unit = units.find((u) => u.id !== RS_UNIT_OTHER && u.name.trim() === a.unit.trim())
    set(g.key, {
      aId: id,
      aTitle: '',
      ...(!g.barCode.trim() && { barCode: a.code }),
      ...(!g.name.trim() && { name: a.title }),
      ...(a.unit && !g.name.trim() && !g.barCode.trim() && (unit ? { unitId: String(unit.id) } : { unitId: String(RS_UNIT_OTHER), unitTxt: a.unit })),
    })
  }
  /** Fills the line from a product of the list; every field stays editable. */
  const fill = (key: string, productId: string) => {
    const p = products.find((x) => x.id === productId)
    if (!p) return
    // A unit RS.ge no longer lists goes in as "other" with its name.
    const listed = units.some((u) => u.id === p.unitId)
    const a = p.aId ? akciz.find((x) => x.id === p.aId) : undefined
    set(key, {
      productId: p.id,
      barCode: p.barCode,
      name: p.name,
      unitId: String(listed ? p.unitId : RS_UNIT_OTHER),
      unitTxt: p.unitTxt,
      vatType: String(p.vatType ?? 0),
      aId: p.aId ? String(p.aId) : '',
      aTitle: p.aId ? (a ? `${a.code} · ${a.title}` : String(p.aId)) : '',
      // A product without a price leaves what was typed.
      ...(p.price != null && { price: String(p.price) }),
    })
  }

  return (
    <div className="sm:col-span-2">
      <p className="mb-1.5 text-sm font-medium text-slate-700">პროდუქტები</p>
      <p className="mb-2 text-xs text-slate-500">
        თითოეული ზედნადებზე ცალკე სტრიქონად წავა. ჩაწერე ხელით ან <Search className="inline size-3.5 align-[-2px]" /> ღილაკით შეავსე პროდუქტების ცნობარიდან (კოდი, დასახელება, ერთეული, ფასი, დაბეგვრა, აქციზი) — შემდეგ ყველაფერი შეიძლება შეიცვალოს. ოპერატორი რეისზე მხოლოდ რაოდენობას წერს.
      </p>
      <div className="space-y-2">
        {goods.map((g, i) => {
          const err = (f: keyof GoodDraft) => errors[`${g.key}.${f}`]
          const other = Number(g.unitId) === RS_UNIT_OTHER
          // A product whose bar code is already on another line can't be picked again.
          const taken = new Set(goods.filter((x) => x.key !== g.key).map((x) => x.barCode.trim().toLowerCase()))
          return (
            <div key={g.key} className="rounded-[10px] p-3 ring-1 ring-slate-200">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500">{i + 1}.</span>
                <button type="button" onClick={() => onChange(goods.filter((x) => x.key !== g.key))} className="-my-1 rounded-lg p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="პროდუქტის მოხსნა">
                  <X className="size-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="col-span-2 sm:col-span-3">
                  <Field label="დასახელება" error={err('name')}>
                    <div className="relative">
                      <Input value={g.name} placeholder="ღორღი 0–5 მმ" invalid={!!err('name')} className={products.length ? 'pr-11' : undefined} onChange={(e) => set(g.key, { name: e.target.value })} />
                      {products.length > 0 && (
                        <div className="absolute inset-y-0 right-1 flex items-center">
                          <Select searchable icon={<Search className="size-4" />} title="RS.ge-ს პროდუქტების სიიდან" aria-label="RS.ge-ს პროდუქტების სიიდან" value="" onChange={(e) => fill(g.key, e.target.value)}>
                            {products.map((x) => (
                              <option key={x.id} value={x.id} disabled={taken.has(x.barCode.toLowerCase())}>
                                {x.name} · {x.barCode}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                    </div>
                  </Field>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <Field label="შტრიხკოდი" error={err('barCode')}>
                    <Input
                      value={g.barCode}
                      className="font-mono"
                      invalid={!!err('barCode')}
                      // Another bar code is another product: the line no longer comes from the list.
                      onChange={(e) => set(g.key, { barCode: e.target.value, productId: products.find((x) => x.id === g.productId)?.barCode === e.target.value.trim() ? g.productId : '' })}
                    />
                  </Field>
                </div>
                <div className={cx(other ? 'col-span-1' : 'col-span-2')}>
                  <Field label="საზომი ერთეული">
                    <Select searchable={units.length > 8} value={g.unitId} onChange={(e) => set(g.key, { unitId: e.target.value })}>
                      {units.map((u) => (
                        <option key={u.id} value={String(u.id)}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {other && (
                  <div className="col-span-1">
                    <Field label="ერთეულის სახელი" error={err('unitTxt')}>
                      <Input value={g.unitTxt} placeholder="ტონა" invalid={!!err('unitTxt')} onChange={(e) => set(g.key, { unitTxt: e.target.value })} />
                    </Field>
                  </div>
                )}
                <div className="col-span-1">
                  <Field label="ერთეულის ფასი (₾)" error={err('price')}>
                    <Input type="text" inputMode="decimal" value={g.price} placeholder="0.00" invalid={!!err('price')} onChange={(e) => set(g.key, { price: e.target.value })} />
                  </Field>
                </div>
                <div className="col-span-1">
                  <Field label="დაბეგვრის ტიპი">
                    <Select value={g.vatType} onChange={(e) => set(g.key, { vatType: e.target.value })}>
                      {RS_VAT_TYPES.map((v) => (
                        <option key={v.value} value={String(v.value)}>
                          {v.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {(akciz.length > 0 || g.aId) && (
                  <div className="col-span-2 sm:col-span-4">
                    <Field label="აქციზი (მხოლოდ აქციზური საქონლისთვის)">
                      <Select searchable value={g.aId} onChange={(e) => pickAkciz(g, e.target.value)}>
                        <option value="">არ არის აქციზური</option>
                        {g.aId && !akciz.some((a) => String(a.id) === g.aId) && <option value={g.aId}>{g.aTitle || g.aId}</option>}
                        {akciz.map((a) => (
                          <option key={a.id} value={String(a.id)}>
                            {a.code} · {a.title}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <Button type="button" variant="secondary" size="sm" className="mt-2" icon={<Plus className="size-4" />} onClick={() => onChange([...goods, blankGood(d)])}>
        პროდუქტის დამატება
      </Button>
      {errors.goods && <p className="mt-2 text-xs text-rose-600">{errors.goods}</p>}
    </div>
  )
}
