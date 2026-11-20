import type { CarrierRoute, RouteWaybill, RsSettings, Shipment, ShipmentWaybill } from '../types.ts'

/** Plate number compared the way RS.ge stores it: AA-123-BB = AA123BB. */
export const plateKey = (v: string) => v.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

/** A goods line's total (AMOUNT): the one typed in, else quantity × price, to the tetri — as RS.ge's form fills it. */
export const itemAmount = (g: { quantity: number; price: number; amount?: number }) => g.amount ?? Math.round(g.quantity * g.price * 100) / 100

/** The shipment's quantity as RS.ge has it (once the waybill is there), else as typed; 0 while RS.ge's copy isn't read. */
export const shipmentQuantity = (s: Shipment) => s.rsRemote?.quantity ?? s.quantity ?? 0

/**
 * Badge tone of a waybill's state, shared by every list that shows one (the main tab and the RS.ge tab):
 * loud only for what needs attention, gray once nothing more will happen to it.
 */
export const WAYBILL_TONE = {
  saved: 'amber',
  active: 'green',
  withCarrier: 'blue',
  closed: 'gray',
  cancelled: 'gray',
} as const

/** Label and badge tone of an RS.ge waybill status. */
export const RS_STATUS: Record<number, { label: string; tone: (typeof WAYBILL_TONE)[keyof typeof WAYBILL_TONE] }> = {
  0: { label: 'შენახული', tone: WAYBILL_TONE.saved },
  1: { label: 'აქტიური', tone: WAYBILL_TONE.active },
  2: { label: 'დასრულებული', tone: WAYBILL_TONE.closed },
  8: { label: 'გადამზიდავთან', tone: WAYBILL_TONE.withCarrier },
  [-1]: { label: 'წაშლილი', tone: WAYBILL_TONE.cancelled },
  [-2]: { label: 'გაუქმებული', tone: WAYBILL_TONE.cancelled },
}

/** UNIT_ID meaning "other": the unit name is then sent in UNIT_TXT. */
export const RS_UNIT_OTHER = 99
/** Used until the connection loads the real unit list from RS.ge. */
export const FALLBACK_UNITS = [{ id: RS_UNIT_OTHER, name: 'სხვა' }]

/** RS.ge's units, always with "other" (99) among them. */
export const rsUnits = (rs: RsSettings) => (rs.units.some((u) => u.id === RS_UNIT_OTHER) ? rs.units : [...rs.units, ...FALLBACK_UNITS])

/**
 * The unit an excise code fixes on a goods line, as RS.ge's own form locks it: RS.ge's unit of that
 * name, else "other" with the excise list's unit name (e.g. ღერი, which RS.ge's unit list doesn't have).
 */
export function akcizUnit(rs: RsSettings, a: { unit: string }) {
  const name = a.unit.trim()
  const unit = rsUnits(rs).find((u) => u.id !== RS_UNIT_OTHER && u.name.trim() === name)
  return unit ? { unitId: unit.id, unitTxt: unit.name } : { unitId: RS_UNIT_OTHER, unitTxt: name }
}

/** A new product's unit: tonnes when RS.ge has such a unit, otherwise "other" (named ტონა). */
export const tonneUnit = (rs: RsSettings) => rsUnits(rs).find((u) => u.id !== RS_UNIT_OTHER && /^ტონ/.test(u.name))?.id ?? RS_UNIT_OTHER

/** TRANS_ID meaning "other": the transport type is then sent in TRANS_TXT. */
export const RS_TRANS_OTHER = 4

/** TRANS_ID საავტომობილო: what a new shipment starts with. */
export const RS_TRANS_CAR = 1

/** TRANS_ID საავტომობილო - უცხო ქვეყნის. */
export const RS_TRANS_FOREIGN_CAR = 6

/** TRANS_ID გადამზიდავი: a transport company carries the goods (TRANSPORTER_TIN). */
export const RS_TRANS_TRANSPORTER = 7

/*
 * What RS.ge's own form asks for on a შიდა გადაზიდვა, by transport type (checked on eservices.rs.ge,
 * 2026-11-20): სარკინიგზო, საავიაციო and სხვა have no vehicle and no transport cost (სხვა asks for its
 * name); the others have ტრანსპორტირების ხარჯი; only საავტომობილო - უცხო ქვეყნის also asks who pays it;
 * გადამზიდავი asks for the transporter's ს/ნ. მიმწოდებლის / მიმღების ინფორმაცია are not on the form.
 */
const NO_VEHICLE = [2, 3, RS_TRANS_OTHER]

/** The transport type has a vehicle and so a ტრანსპორტირების ხარჯი. */
export const transHasCost = (transId: number) => !NO_VEHICLE.includes(transId)

/** RS.ge asks who pays the transport cost (on a შიდა გადაზიდვა only for a foreign car). */
export const transHasPayer = (transId: number) => transId === RS_TRANS_FOREIGN_CAR

/** RS.ge asks for the transport company's ს/ნ. */
export const transHasTransporter = (transId: number) => transId === RS_TRANS_TRANSPORTER

/** RS.ge's transport types; until the connection has read them, the list RS.ge's form had on 2026-11-20. */
export const transTypes = (rs: RsSettings) =>
  rs.transTypes.length
    ? rs.transTypes
    : [
        { id: RS_TRANS_CAR, name: 'საავტომობილო' },
        { id: 2, name: 'სარკინიგზო' },
        { id: 3, name: 'საავიაციო' },
        { id: RS_TRANS_OTHER, name: 'სხვა' },
        { id: RS_TRANS_FOREIGN_CAR, name: 'საავტომობილო - უცხო ქვეყნის' },
        { id: RS_TRANS_TRANSPORTER, name: 'გადამზიდავი' },
        { id: 8, name: 'მოპედი/მოტოციკლი' },
      ]

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
    units: [],
    transTypes: [],
  }
}

/**
 * What is still missing before a waybill can be sent. Empty array = ready.
 * The server enforces it; the admin screen shows the same list.
 */
export function rsMissing(rs: RsSettings, opts: { hasCreds: boolean }): string[] {
  const out: string[] = []
  // Connecting fills in the seller (also the buyer: every waybill is შიდა გადაზიდვა).
  if (!opts.hasCreds || !rs.sellerTin) out.push('სერვისის მომხმარებელი და პაროლი')
  return out
}

/** RS.ge's names of its waybill types. This app writes only 1 (შიდა გადაზიდვა); the others show on older shipments and on RS.ge's lists. */
const WAYBILL_TYPE_NAMES: Record<number, string> = { 1: 'შიდა გადაზიდვა', 2: 'ტრანსპორტირებით', 3: 'ტრანსპორტირების გარეშე', 4: 'დისტრიბუცია', 5: 'უკან დაბრუნება', 6: 'ქვე-ზედნადები' }

/** Label of any RS.ge waybill type, also the ones this app doesn't write. */
export const waybillTypeLabel = (t?: number) => WAYBILL_TYPE_NAMES[t ?? 0] ?? (t ? `ტიპი ${t}` : '—')

/** Types with no transport (older shipments only): no driver, truck or end address (RS.ge wants the end = the start). */
export const noTransport = (t: number) => t === 3

/** RS.ge accepts a start of transport at most this far ahead (code -1038). */
export const MAX_DEFER_MS = 3 * 86400_000

/**
 * The waybill of a shipment on this route: always შიდა გადაზიდვა (the buyer is the seller), with the
 * route's transport details as RS.ge's form takes them for its transport type (missing ones: საავტომობილო,
 * the seller pays, the rest empty).
 */
export function waybillDefaults(route?: RouteWaybill): ShipmentWaybill {
  const transId = route?.transId ?? RS_TRANS_CAR
  return {
    type: 1,
    buyerTin: '',
    buyerName: '',
    buyerForeign: false,
    transId,
    transTxt: transId === RS_TRANS_OTHER ? (route?.transTxt ?? '') : '',
    transporterTin: transHasTransporter(transId) ? (route?.transporterTin ?? '') : '',
    transportCost: transHasCost(transId) ? (route?.transportCost ?? 0) : 0,
    tranCostPayer: transHasPayer(transId) ? (route?.tranCostPayer ?? 2) : 2,
    receptionInfo: '',
    receiverInfo: '',
    comment: route?.comment ?? '',
  }
}

/** A shipment's waybill options; shipments from before they were kept get them from the settings. */
export const shipmentWaybill = (s: Pick<Shipment, 'waybill'>, route?: CarrierRoute): ShipmentWaybill => s.waybill ?? waybillDefaults(route)

/** Whether a shipment can still be changed: not while uploading, not once completed, cancelled or invoiced. */
export const editable = (s: Pick<Shipment, 'waybillState' | 'invoiceId' | 'status'>) => !s.waybillState && !s.invoiceId && (s.status === 'rs_failed' || s.status === 'saved' || s.status === 'uploaded')
