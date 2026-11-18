import type { RsSettings, Shipment } from '../types.ts'

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

/** TRANS_ID meaning "other": the transport type is then sent in TRANS_TXT. */
export const RS_TRANS_OTHER = 4

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
    transporterTin: '',
    transId: 1,
    transTxt: '',
    tranCostPayer: 2,
    transportCost: 0,
    quantity: 0,
    price: 0,
    vatType: 0,
    receptionInfo: '',
    receiverInfo: '',
    comment: '',
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
  // The seller doubles as the buyer (შიდა გადაზიდვა); connecting fills it in.
  if (!opts.hasCreds || !rs.sellerTin) out.push('სერვისის მომხმარებელი და პაროლი')
  if (!(rs.quantity > 0)) out.push('დეკლარირებული რაოდენობა')
  if (rs.transId === RS_TRANS_OTHER && !rs.transTxt) out.push('ტრანსპორტის ტიპის დასახელება')
  if (!(rs.price >= 0)) out.push('ერთეულის ფასი')
  return out
}
