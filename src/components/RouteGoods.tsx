/*
 * The goods lines of a route, as the admin writes them: bar code, name and unit typed in (or filled
 * from the RS.ge product list with the search button, and then still editable; nothing is added to
 * RS.ge's list), plus the price, line total (quantity × price unless typed in), VAT type, quantity and
 * optional additional quantity. Every shipment
 * on the route carries them as they are.
 */
import { useEffect, useState } from 'react'
import { Ban, ChevronDown, ChevronRight, ChevronUp, Pencil, Plus, Search, Stamp, X } from 'lucide-react'
import { Button, Field, Input, Select } from './ui'
import { bareCls, compoundCls, invalidCls } from './fieldStyles'
import { OptionRow } from './pickers'
import { active, cx, uid } from '../lib/util'
import { akcizUnit, itemAmount, RS_UNIT_OTHER, RS_VAT_TYPES, rsUnits, tonneUnit } from '../lib/rs'
import type { Database, ShipmentItem } from '../types'
import type { NewRouteGood } from '../api'

/** A goods line in the form: every value as typed. */
export interface GoodDraft {
  /** React key; stays the same while the form is open. */
  key: string
  name: string
  barCode: string
  unitId: string
  unitTxt: string
  price: string
  /** საქონლის ფასი typed in by hand; '' = quantity × price. */
  amount: string
  vatType: string
  /** Excise code id; '' = not excise goods. aTitle shows a stored code RS.ge's list doesn't have (yet). */
  aId: string
  aTitle: string
  quantity: string
  /** '' = none. */
  quantityExt: string
}

export const blankGood = (d: Database): GoodDraft => ({
  key: uid('k'),
  name: '',
  barCode: '',
  unitId: String(tonneUnit(d.rs)),
  unitTxt: 'ტონა',
  price: '',
  amount: '',
  vatType: '0',
  aId: '',
  aTitle: '',
  quantity: '',
  quantityExt: '',
})

export const toDraft = (g: ShipmentItem): GoodDraft => ({
  key: uid('k'),
  name: g.name,
  barCode: g.barCode,
  unitId: String(g.unitId),
  unitTxt: g.unitTxt,
  price: String(g.price),
  amount: g.amount != null ? String(g.amount) : '',
  vatType: String(g.vatType),
  aId: g.aId ? String(g.aId) : '',
  aTitle: g.aTitle ?? '',
  quantity: g.quantity ? String(g.quantity) : '',
  quantityExt: g.quantityExt ? String(g.quantityExt) : '',
})

/** The excise code of an excise line, when RS.ge's list has it: its bar code and unit are locked to it. */
const akcizOf = (d: Database, g: GoodDraft) => (g.aId ? d.rs.akciz?.find((a) => String(a.id) === g.aId) : undefined)

const strUnit = (u: { unitId: number; unitTxt: string }) => ({ unitId: String(u.unitId), unitTxt: u.unitTxt })

/** A number as typed (a comma is the decimal sign too); NaN when it isn't one, null when empty. */
const numOf = (v: string) => (v.trim() ? Number(v.trim().replace(',', '.')) : null)

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
    const price = numOf(g.price)
    if (price == null || !(price >= 0)) e[at('price')] = 'შეიყვანე 0 ან მეტი'
    const amount = numOf(g.amount)
    if (amount != null && !(amount >= 0)) e[at('amount')] = '0 ან მეტი, ან ცარიელი'
    const q = numOf(g.quantity)
    if (q == null || !(q > 0)) e[at('quantity')] = 'შეიყვანე 0-ზე მეტი'
    const ext = numOf(g.quantityExt)
    if (ext != null && !(ext > 0)) e[at('quantityExt')] = '0-ზე მეტი ან ცარიელი'
  }
  if (!goods.length) e.goods = 'დაამატე მინიმუმ ერთი პროდუქტი'
  return e
}

/** The lines as the server takes them. Call after checkGoods passed. */
export function fromDrafts(d: Database, goods: GoodDraft[]): NewRouteGood[] {
  const units = rsUnits(d.rs)
  return goods.map((g) => {
    const a = akcizOf(d, g)
    const unitId = a ? akcizUnit(d.rs, a).unitId : Number(g.unitId)
    const ext = numOf(g.quantityExt)
    const amount = numOf(g.amount)
    return {
      name: g.name.trim(),
      barCode: (a?.code ?? g.barCode).trim(),
      unitId,
      unitTxt: a ? akcizUnit(d.rs, a).unitTxt : unitId === RS_UNIT_OTHER ? g.unitTxt.trim() : (units.find((u) => u.id === unitId)?.name ?? g.unitTxt.trim()),
      price: numOf(g.price) ?? 0,
      ...(amount != null && { amount: Math.round(amount * 100) / 100 }),
      vatType: Number(g.vatType) as 0 | 1 | 2,
      ...(g.aId && { aId: Number(g.aId) }),
      quantity: Math.round((numOf(g.quantity) ?? 0) * 1000) / 1000,
      ...(ext && { quantityExt: Math.round(ext * 1000) / 1000 }),
    }
  })
}

/** A line's number, as on the waybill. */
const LineNo = ({ n }: { n: number }) => <span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-500/15 text-[12px] font-semibold text-slate-600 tabular-nums">{n}</span>

const money = (v: number | null) => (v != null && v >= 0 ? `${v.toFixed(2)} ₾` : '—')

export function RouteGoodsEditor({ d, goods, onChange, errors, onClearError }: { d: Database; goods: GoodDraft[]; onChange: (g: GoodDraft[]) => void; errors: Record<string, string>; onClearError: (key: string) => void }) {
  const products = active(d.products)
  const units = rsUnits(d.rs)
  const set = (key: string, patch: Partial<GoodDraft>) => {
    onChange(goods.map((g) => (g.key === key ? { ...g, ...patch } : g)))
    for (const f of Object.keys(patch)) onClearError(`${key}.${f}`)
    onClearError('goods')
  }
  const akciz = d.rs.akciz ?? []
  /**
   * Marks the line as excise goods, as RS.ge's own form does: the bar code becomes the excise goods
   * code and the unit the code's unit, both locked; the name is filled from the code (and stays editable).
   */
  const pickAkciz = (g: GoodDraft, id: string) => {
    const a = akciz.find((x) => String(x.id) === id)
    if (!a) return set(g.key, { aId: '', aTitle: '' })
    set(g.key, { aId: id, aTitle: '', barCode: a.code, name: a.title, ...strUnit(akcizUnit(d.rs, a)) })
  }
  /** Fills the line from a product of RS.ge's list; every field stays editable. */
  const fill = (key: string, productId: string) => {
    const p = products.find((x) => x.id === productId)
    if (!p) return
    // A unit RS.ge no longer lists goes in as "other" with its name.
    const listed = units.some((u) => u.id === p.unitId)
    const a = p.aId ? akciz.find((x) => x.id === p.aId) : undefined
    set(key, {
      // An excise product goes on the waybill under its excise goods code, as on RS.ge's form.
      barCode: a ? a.code : p.barCode,
      name: p.name,
      ...(a ? strUnit(akcizUnit(d.rs, a)) : { unitId: String(listed ? p.unitId : RS_UNIT_OTHER), unitTxt: p.unitTxt }),
      aId: p.aId ? String(p.aId) : '',
      aTitle: p.aId ? (a ? `${a.code} · ${a.title}` : String(p.aId)) : '',
      // The product's price and VAT type, when it has them; otherwise what is typed on the line stays.
      ...(p.price != null && { price: String(p.price), amount: '' }),
      ...(p.vatType != null && { vatType: String(p.vatType) }),
    })
  }

  // One line is open at a time; the others fold into a summary row. A single or unfinished line starts open.
  const [openKey, setOpenKey] = useState<string | null>(() => (goods.length === 1 ? goods[0].key : (goods.find((g) => Object.keys(checkGoods([g])).length)?.key ?? null)))
  // Lines whose rarely used fields (additional quantity, excise) are shown.
  const [moreOpen, setMoreOpen] = useState<ReadonlySet<string>>(() => new Set())
  // The line whose საქონლის ფასი is being typed in by hand.
  const [editAmount, setEditAmount] = useState<string | null>(null)

  const lineBad = (key: string) => Object.keys(errors).some((k) => k.startsWith(`${key}.`) && errors[k])
  // After a failed save, the first line with a mistake opens (the open one stays if it has one).
  useEffect(() => {
    if (openKey && lineBad(openKey)) return
    const bad = goods.find((g) => lineBad(g.key))
    if (bad) setOpenKey(bad.key)
    // Only a new set of errors moves the open line.
  }, [errors])

  const add = () => {
    const g = blankGood(d)
    onChange([...goods, g])
    setOpenKey(g.key)
  }
  const remove = (key: string) => {
    const rest = goods.filter((x) => x.key !== key)
    onChange(rest)
    // The last line left stays open: it can't be folded on its own.
    if (rest.length === 1) setOpenKey(rest[0].key)
  }

  // At least one goods line always stays: the only one can't be removed.
  const removeBtn = (key: string) =>
    goods.length > 1 && (
      <button type="button" onClick={() => remove(key)} className="grid size-7 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-rose-500/15 hover:text-rose-600" title="პროდუქტის მოხსნა" aria-label="პროდუქტის მოხსნა">
        <X className="size-4" />
      </button>
    )

  return (
    <div>
      <p className="mb-1 ml-1 text-[12px] font-medium text-slate-600">პროდუქტები</p>
      <div className="space-y-2">
        {goods.map((g, i) => {
          const err = (f: keyof GoodDraft) => errors[`${g.key}.${f}`]
          // Excise goods go under their excise goods code and unit, locked as on RS.ge's form.
          const exc = akcizOf(d, g)
          const locked = exc?.code
          const lockedUnit = exc && akcizUnit(d.rs, exc)
          const unitId = lockedUnit ? String(lockedUnit.unitId) : g.unitId
          const other = Number(unitId) === RS_UNIT_OTHER
          const unitName = lockedUnit?.unitTxt ?? (other ? g.unitTxt : (units.find((u) => String(u.id) === unitId)?.name ?? g.unitTxt))
          // საქონლის ფასი as RS.ge's form fills it: quantity × price, until one is typed in (a new quantity or price recalculates it).
          const q = numOf(g.quantity)
          const pr = numOf(g.price)
          const auto = q != null && pr != null && q >= 0 && pr >= 0 ? itemAmount({ quantity: q, price: pr }).toFixed(2) : ''
          const manual = g.amount.trim() !== ''
          const total = manual ? numOf(g.amount) : auto ? Number(auto) : null
          const bad = lineBad(g.key)

          if (openKey !== g.key) {
            // A folded line: what it is and what it comes to, in one row.
            return (
              <div key={g.key} className={cx('@container flex items-center gap-1 rounded-[12px] bg-slate-50 pr-2 transition-colors hover:bg-slate-100', bad && 'ring-2 ring-rose-500/60 ring-inset')}>
                <button type="button" onClick={() => setOpenKey(g.key)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-3 text-left" aria-expanded={false}>
                  <LineNo n={i + 1} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 @lg:flex-row @lg:items-center @lg:gap-4">
                    <span className="min-w-0 flex-1">
                      <span className={cx('block truncate text-[14px] font-medium', g.name.trim() ? 'text-slate-900' : 'text-slate-400')}>{g.name.trim() || 'უსახელო პროდუქტი'}</span>
                      <span className="block truncate font-mono text-xs text-slate-500">{(locked ?? g.barCode).trim() || 'შტრიხკოდის გარეშე'}</span>
                    </span>
                    <span className="shrink-0 text-[13px] text-slate-600 tabular-nums">
                      {g.quantity.trim() || '—'} {unitName} × {money(pr)} <span className="font-semibold text-slate-900">= {money(total)}</span>
                    </span>
                  </span>
                  {bad && <span className="shrink-0 text-xs font-medium text-rose-600">შესასწორებელია</span>}
                  <ChevronDown className="size-4 shrink-0 text-slate-400" />
                </button>
                {removeBtn(g.key)}
              </div>
            )
          }

          // A product whose bar code is already on another line can't be picked again.
          const taken = new Set(goods.filter((x) => x.key !== g.key).map((x) => x.barCode.trim().toLowerCase()))
          const showAkciz = akciz.length > 0 || !!g.aId
          // Filled-in extras stay in view; empty ones fold away behind "მეტი".
          const extrasSet = !!g.quantityExt.trim() || !!g.aId || !!err('quantityExt')
          const extras = extrasSet || moreOpen.has(g.key)
          const toggleMore = () =>
            setMoreOpen((s) => {
              const n = new Set(s)
              if (n.has(g.key)) n.delete(g.key)
              else n.add(g.key)
              return n
            })

          return (
            <div key={g.key} className="@container rounded-[12px] bg-slate-50 p-3 sm:p-4">
              <div className="mb-3 flex items-center gap-2.5">
                <LineNo n={i + 1} />
                <button
                  type="button"
                  onClick={() => goods.length > 1 && setOpenKey(null)}
                  className={cx('flex min-w-0 flex-1 items-center gap-1.5 text-left', goods.length > 1 && 'cursor-pointer')}
                  aria-expanded
                  title={goods.length > 1 ? 'ჩაკეცვა' : undefined}
                >
                  <span className={cx('truncate text-[14px] font-semibold', g.name.trim() ? 'text-slate-900' : 'text-slate-400')}>{g.name.trim() || 'ახალი პროდუქტი'}</span>
                  {goods.length > 1 && <ChevronUp className="size-4 shrink-0 text-slate-400" />}
                </button>
                {removeBtn(g.key)}
              </div>

              <div className="animate-fade-in space-y-3">
                {/* What it is */}
                <div className="grid grid-cols-1 gap-3 @md:grid-cols-[minmax(0,1fr)_13rem]">
                  <Field label="დასახელება" error={err('name')}>
                    <div className="relative">
                      <Input value={g.name} placeholder="ღორღი 0–5 მმ" invalid={!!err('name')} className={products.length ? 'pr-11' : undefined} onChange={(e) => set(g.key, { name: e.target.value })} />
                      {products.length > 0 && (
                        <div className="absolute inset-y-0 right-1 flex items-center">
                          <Select searchable rich icon={<Search className="size-4" />} title="RS.ge-ს პროდუქტების სიიდან" aria-label="RS.ge-ს პროდუქტების სიიდან" value="" onChange={(e) => fill(g.key, e.target.value)}>
                            {products.map((x) => (
                              <option key={x.id} value={x.id} label={x.name} data-search={x.barCode} disabled={taken.has(x.barCode.toLowerCase())}>
                                <OptionRow
                                  title={x.name}
                                  sub={
                                    <>
                                      <span className="shrink-0 tabular-nums">{x.barCode}</span>
                                      <span className="min-w-0 truncate">{[x.unitTxt, x.price != null && `${x.price.toFixed(2)} ₾`].filter(Boolean).join(' · ')}</span>
                                    </>
                                  }
                                />
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                    </div>
                  </Field>
                  <Field label={locked ? 'შტრიხკოდი (აქციზის კოდი)' : 'შტრიხკოდი'} error={err('barCode')}>
                    <Input
                      value={locked ?? g.barCode}
                      readOnly={locked != null}
                      title={locked != null ? 'აქციზური საქონლის კოდი — იცვლება აქციზის არჩევით' : undefined}
                      className={cx('font-mono', locked != null && 'text-slate-500')}
                      invalid={!!err('barCode')}
                      onChange={(e) => set(g.key, { barCode: e.target.value })}
                    />
                  </Field>
                </div>

                {/* How much: quantity × unit price = line total */}
                <div className="grid grid-cols-1 gap-3 @md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)]">
                  <Field label="რაოდენობა" error={err('quantity')}>
                    <div className={cx(compoundCls, err('quantity') && invalidCls)}>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={g.quantity}
                        placeholder="0"
                        aria-invalid={!!err('quantity')}
                        className={cx(bareCls, 'min-w-0 flex-1 text-right tabular-nums')}
                        onChange={(e) => set(g.key, { quantity: e.target.value, amount: '' })}
                      />
                      <span className="my-2 w-px shrink-0 bg-slate-500/30" />
                      <div className="w-[48%] shrink-0">
                        <Select
                          bare
                          aria-label="საზომი ერთეული"
                          searchable={units.length > 8}
                          value={unitId}
                          disabled={!!lockedUnit}
                          title={lockedUnit ? 'აქციზური საქონლის ერთეული — იცვლება აქციზის არჩევით' : 'საზომი ერთეული'}
                          onChange={(e) => set(g.key, { unitId: e.target.value })}
                        >
                          {units.map((u) => (
                            <option key={u.id} value={String(u.id)}>
                              {u.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  </Field>
                  <Field label="× ერთეულის ფასი" error={err('price')}>
                    <Input type="text" inputMode="decimal" value={g.price} placeholder="0.00" suffix="₾" invalid={!!err('price')} onChange={(e) => set(g.key, { price: e.target.value, amount: '' })} />
                  </Field>
                  <div>
                    <Field label="= საქონლის ფასი" error={err('amount')}>
                      {manual || editAmount === g.key ? (
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={g.amount}
                          placeholder={auto || '0.00'}
                          suffix="₾"
                          autoFocus={editAmount === g.key && !manual}
                          invalid={!!err('amount')}
                          onBlur={() => setEditAmount(null)}
                          onChange={(e) => set(g.key, { amount: e.target.value })}
                        />
                      ) : (
                        // Worked out, not typed: plain text until it is clicked to be set by hand.
                        <button
                          type="button"
                          onClick={() => setEditAmount(g.key)}
                          title="რაოდენობა × ერთეულის ფასი — დააჭირე ხელით შესაცვლელად"
                          className="group flex h-11 w-full cursor-text items-center justify-end gap-2 rounded-[10px] px-3 text-[16px] font-semibold text-slate-900 tabular-nums transition-colors hover:bg-fill sm:h-9 sm:rounded-[8px] sm:text-[14px]"
                        >
                          <Pencil className="size-3.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                          {auto ? `${auto} ₾` : <span className="font-normal text-slate-400">—</span>}
                        </button>
                      )}
                    </Field>
                    {manual && !err('amount') && (
                      <p className="mt-1 ml-1 text-xs text-slate-500">
                        ხელით
                        {auto && (
                          <>
                            {' · '}
                            <button type="button" onClick={() => set(g.key, { amount: '' })} className="cursor-pointer font-medium text-brand-600 hover:underline" title="დაბრუნება: რაოდ. × ფასი">
                              გადათვლა ({auto} ₾)
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                </div>

                {/* Tax, and the unit's name when it is RS.ge's "other" */}
                <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
                  <Field label="დაბეგვრის ტიპი">
                    <Select value={g.vatType} onChange={(e) => set(g.key, { vatType: e.target.value })}>
                      {RS_VAT_TYPES.map((v) => (
                        <option key={v.value} value={String(v.value)}>
                          {v.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {other && (
                    <Field label="ერთეულის სახელი" error={err('unitTxt')}>
                      <Input value={lockedUnit?.unitTxt ?? g.unitTxt} readOnly={!!lockedUnit} className={cx(lockedUnit && 'text-slate-500')} placeholder="ტონა" invalid={!!err('unitTxt')} onChange={(e) => set(g.key, { unitTxt: e.target.value })} />
                    </Field>
                  )}
                </div>

                {/* Rarely used: folded away until needed */}
                {!extrasSet && (
                  <button type="button" onClick={toggleMore} aria-expanded={extras} className="-ml-1 flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium text-brand-600 hover:bg-brand-500/10">
                    <ChevronRight className={cx('size-4 transition-transform', extras && 'rotate-90')} />
                    მეტი
                    <span className="font-normal text-slate-500">· დამატებითი რაოდენობა{showAkciz && ', აქციზი'}</span>
                  </button>
                )}
                {extras && (
                  <div className={cx('animate-fade-in grid grid-cols-1 gap-3 @md:grid-cols-[13rem_minmax(0,1fr)]', extrasSet && 'border-t border-slate-500/15 pt-3')}>
                    <Field label="დამატებითი რაოდენობა" error={err('quantityExt')}>
                      <Input type="text" inputMode="decimal" value={g.quantityExt} placeholder="—" invalid={!!err('quantityExt')} onChange={(e) => set(g.key, { quantityExt: e.target.value })} />
                    </Field>
                    {showAkciz && (
                      <Field label="აქციზი (მხოლოდ აქციზური საქონლისთვის)">
                        <Select searchable rich value={g.aId} onChange={(e) => pickAkciz(g, e.target.value)}>
                          <option value="" label="არ არის აქციზური">
                            <OptionRow icon={<Ban />} title="არ არის აქციზური" />
                          </option>
                          {g.aId && !akciz.some((a) => String(a.id) === g.aId) && (
                            <option value={g.aId} label={g.aTitle || g.aId}>
                              <OptionRow icon={<Stamp />} title={g.aTitle || g.aId} />
                            </option>
                          )}
                          {akciz.map((a) => (
                            <option key={a.id} value={String(a.id)} label={`${a.code} · ${a.title}`} data-search={a.code}>
                              <OptionRow icon={<Stamp />} title={a.title} />
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <Button type="button" variant="secondary" size="sm" className="mt-2" icon={<Plus className="size-4" />} onClick={add}>
        პროდუქტის დამატება
      </Button>
      {errors.goods && <p className="mt-2 ml-1 text-xs text-rose-600">{errors.goods}</p>}
    </div>
  )
}
