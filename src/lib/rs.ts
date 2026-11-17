import type { RsSettings } from '../types.ts'

/** UNIT_ID meaning "other": the unit name is then sent in UNIT_TXT. */
export const RS_UNIT_OTHER = 99
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
    buyerTin: '',
    buyerName: '',
    buyerForeign: false,
    transporterTin: '',
    transId: 1,
    transTxt: '',
    tranCostPayer: 2,
    transportCost: 0,
    unitId: RS_UNIT_OTHER,
    unitTxt: 'ტონა',
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
  if (!opts.hasCreds) out.push('სერვისის მომხმარებელი და პაროლი')
  if (!rs.buyerTin) out.push('მყიდველის საიდენტიფიკაციო ნომერი')
  if (!rs.buyerName) out.push('მყიდველის დასახელება')
  // RS.ge refuses a waybill whose buyer is the seller itself (code -1047).
  if (rs.buyerTin && rs.buyerTin === rs.sellerTin) out.push('მყიდველი, რომელიც არ არის თავად გამყიდველი')
  if (!rs.unitId) out.push('საზომი ერთეული')
  if (rs.unitId === RS_UNIT_OTHER && !rs.unitTxt) out.push('ერთეულის დასახელება')
  if (rs.transId === RS_TRANS_OTHER && !rs.transTxt) out.push('ტრანსპორტის ტიპის დასახელება')
  if (!(rs.price >= 0)) out.push('ერთეულის ფასი')
  return out
}
