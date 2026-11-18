import type { CarrierRoute, RsSettings, Shipment, ShipmentWaybill, WaybillType } from '../types.ts'

/** Plate number compared the way RS.ge stores it: AA-123-BB = AA123BB. */
export const plateKey = (v: string) => v.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

/** The shipment's quantity as RS.ge has it (a correction on the rs.ge portal wins), else as declared. */
export const shipmentQuantity = (s: Shipment) => s.rsRemote?.quantity ?? s.quantity

/** Label and badge tone of an RS.ge waybill status. */
export const RS_STATUS: Record<number, { label: string; tone: 'blue' | 'green' | 'gray' | 'red' }> = {
  0: { label: 'შენახული', tone: 'blue' },
  1: { label: 'აქტიური', tone: 'green' },
  2: { label: 'დასრულებული', tone: 'gray' },
  8: { label: 'გადამზიდავთან', tone: 'blue' },
  [-1]: { label: 'წაშლილი', tone: 'red' },
  [-2]: { label: 'გაუქმებული', tone: 'red' },
}

/** UNIT_ID meaning "other": the unit name is then sent in UNIT_TXT. */
export const RS_UNIT_OTHER = 99
/** Used until the connection loads the real unit list from RS.ge. */
export const FALLBACK_UNITS = [{ id: RS_UNIT_OTHER, name: 'სხვა' }]

/** RS.ge's units, always with "other" (99) among them. */
export const rsUnits = (rs: RsSettings) => (rs.units.some((u) => u.id === RS_UNIT_OTHER) ? rs.units : [...rs.units, ...FALLBACK_UNITS])

/** A new product's unit: tonnes when RS.ge has such a unit, otherwise "other" (named ტონა). */
export const tonneUnit = (rs: RsSettings) => rsUnits(rs).find((u) => u.id !== RS_UNIT_OTHER && /^ტონ/.test(u.name))?.id ?? RS_UNIT_OTHER

/** TRANS_ID meaning "other": the transport type is then sent in TRANS_TXT. */
export const RS_TRANS_OTHER = 4

/** VAT_TYPE of a goods line. */
export const RS_VAT_TYPES = [
  { value: 0, label: 'ჩვეულებრივი' },
  { value: 1, label: 'ნულოვანი' },
  { value: 2, label: 'დაუბეგრავი' },
] as const

/** Settings for a fresh install: nothing filled in yet. */
export function defaultRsSettings(): RsSettings {
  return {
    su: '',
    sp: '',
    sellerUnId: null,
    sellerUserId: null,
    sellerTin: '',
    sellerName: '',
    buyerTin: '',
    buyerName: '',
    buyerForeign: false,
    transporterTin: '',
    transId: 1,
    transTxt: '',
    tranCostPayer: 2,
    transportCost: 0,
    quantity: 0,
    receptionInfo: '',
    receiverInfo: '',
    comment: '',
    units: [],
    transTypes: [],
  }
}

/** True when the waybill goes to the seller itself: no buyer set, or the seller's own number. */
export const isInternal = (rs: Pick<RsSettings, 'buyerTin' | 'sellerTin'>) => !rs.buyerTin || rs.buyerTin === rs.sellerTin

/**
 * What is still missing before a waybill can be sent. Empty array = ready.
 * The server enforces it; the admin screen shows the same list.
 */
export function rsMissing(rs: RsSettings, opts: { hasCreds: boolean }): string[] {
  const out: string[] = []
  // Connecting fills in the seller (also the buyer when none is set: შიდა გადაზიდვა).
  if (!opts.hasCreds || !rs.sellerTin) out.push('სერვისის მომხმარებელი და პაროლი')
  if (rs.transId === RS_TRANS_OTHER && !rs.transTxt) out.push('ტრანსპორტის ტიპის დასახელება')
  return out
}

/** Waybill types this app writes, as the RS.ge portal names them. */
export const WAYBILL_TYPES: { value: WaybillType; label: string; hint: string }[] = [
  { value: 1, label: 'შიდა გადაზიდვა', hint: 'კომპანიის ობიექტებს შორის — მყიდველი თავად გამყიდველია' },
  { value: 2, label: 'მიწოდება ტრანსპორტირებით', hint: 'ტვირთი მიდის მყიდველთან' },
  { value: 3, label: 'ტრანსპორტირების გარეშე', hint: 'მყიდველი ტვირთს ადგილზე იბარებს — მძღოლი და მანქანა არ არის საჭირო' },
  { value: 5, label: 'უკან დაბრუნება', hint: 'საქონლის დაბრუნება მყიდველისგან' },
]

/** Label of any RS.ge waybill type, also the ones this app doesn't write. */
export const waybillTypeLabel = (t?: number) =>
  WAYBILL_TYPES.find((x) => x.value === t)?.label ?? ({ 4: 'დისტრიბუცია', 6: 'ქვე-ზედნადები' } as Record<number, string>)[t ?? 0] ?? (t ? `ტიპი ${t}` : '—')

/** Types with no transport: no driver, truck or end address (RS.ge wants the end = the start). */
export const noTransport = (t: number) => t === 3

/** RS.ge accepts a start of transport at most this far ahead (code -1038). */
export const MAX_DEFER_MS = 3 * 86400_000

/**
 * The waybill a new shipment on this route starts with: the route's type and buyer, else the
 * settings' (no buyer → შიდა გადაზიდვა). Transport details come from the settings.
 */
export function waybillDefaults(rs: RsSettings, route?: Pick<CarrierRoute, 'waybillType' | 'buyerTin' | 'buyerName' | 'buyerForeign'>): ShipmentWaybill {
  const own = !!route?.buyerTin
  const buyer = own ? { buyerTin: route!.buyerTin!, buyerName: route!.buyerName ?? '', buyerForeign: !!route!.buyerForeign } : { buyerTin: rs.buyerTin, buyerName: rs.buyerName, buyerForeign: rs.buyerForeign }
  const internal = isInternal({ buyerTin: buyer.buyerTin, sellerTin: rs.sellerTin })
  const type: WaybillType = route?.waybillType ?? (internal ? 1 : 2)
  return {
    type,
    ...(type === 1 ? { buyerTin: '', buyerName: '', buyerForeign: false } : buyer),
    transportCost: rs.transportCost,
    tranCostPayer: rs.tranCostPayer,
    receptionInfo: rs.receptionInfo,
    receiverInfo: rs.receiverInfo,
    comment: rs.comment,
  }
}

/** A shipment's waybill options; shipments from before they were kept get them from the settings. */
export const shipmentWaybill = (s: Pick<Shipment, 'waybill'>, rs: RsSettings, route?: CarrierRoute): ShipmentWaybill => s.waybill ?? waybillDefaults(rs, route)

/** Whether a shipment can still be changed: not while uploading, not once completed, cancelled or invoiced. */
export const editable = (s: Pick<Shipment, 'waybillState' | 'invoiceId' | 'status'>) => !s.waybillState && !s.invoiceId && (s.status === 'rs_failed' || s.status === 'saved' || s.status === 'uploaded')
