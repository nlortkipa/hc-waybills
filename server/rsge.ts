/**
 * RS.ge electronic waybill (ელექტრონული ზედნადები) client.
 *
 * Protocol: docs/rs-ge/waybill_protocol.pdf (v4.0.4). SOAP 1.1 over HTTPS, no dependencies.
 * Flow for one shipment: save_waybill (returns the waybill ID) → send_waybil_vd (activates it with
 * the transport start time, returns the waybill number). Later: close_waybill (delivered) or
 * ref_waybill (cancel; also allowed on a completed waybill). A saved draft that was never
 * activated can only be deleted (del_waybill): ref_waybill answers 0 and leaves it as it is.
 * Reading back: get_waybill (one waybill as RS.ge has it now) and get_waybills_v1 (what changed
 * in a time window), used to keep shipments in step with changes made on the rs.ge portal.
 * Trucks: the taxpayer's car-number list (get_car_numbers / save_car_numbers / delete_car_numbers),
 * the same list the rs.ge portal offers when a waybill is typed in.
 * Products: the taxpayer's product list on RS.ge (get_bar_codes / save_bar_code / delete_bar_code,
 * "სასაქონლო კოდების აღრიცხვა"). save_bar_code adds or overwrites by bar code; delete_bar_code
 * also answers 1 for a code that isn't there. save_bar_code also answers 1 for codes it silently
 * doesn't store (common ones like 67, 123 or asd, apparently because another taxpayer already has
 * them), so a save is only trusted after reading the code back.
 *
 * RS.ge has no separate sandbox host: testing is done on the normal endpoint with a test
 * service user. The service user (su / sp) comes from .env (server/config.ts). Every call goes
 * to the integration log, with the password masked. Read-backs are tagged
 * (readBack) so the log keeps them apart from the uploads.
 *
 * What RS.ge says about the service user (the seller, its units, transport types and excise codes)
 * is kept in memory only (`account`): read on connect, or on first need after a restart.
 */
import type { IntegrationLog, RsAkciz, RsListWaybill, RsRefItem, RsRemoteWaybill, RsWaybillPayload } from '../src/types.ts'
import { RS_SP, RS_SU } from './config.ts'
import { IntegrationError, log } from './integrations.ts'

/** The connected service user as RS.ge describes it. Memory only. */
export interface RsAccount {
  /** The su it belongs to: a different stored su makes it stale. */
  su: string
  unId: number
  userId: number | null
  tin: string
  name: string
  units: RsRefItem[]
  akciz: RsAkciz[]
  checkedAt: string
}

const URL = process.env.RS_WAYBILL_URL ?? 'https://services.rs.ge/WayBillService/WayBillService.asmx'
const NS = 'http://tempuri.org/'
const TIMEOUT_MS = 30_000
const LOG_ENDPOINT = (op: string) => `POST services.rs.ge/WayBillService › ${op}`

export interface RsCreds {
  su: string
  sp: string
}

/** A product in the taxpayer's RS.ge product list. */
export interface RsBarCode {
  barCode: string
  name: string
  unitId: number
  unitTxt: string
  /** Excise code; 0 = not excise goods. */
  aId: number
}

/** A waybill found on RS.ge. status: 0 saved, 1 active, 2 completed, -1 deleted, -2 cancelled. */
export interface FoundWaybill {
  id: number
  status: number
  number: string
}

const rsError = (message: string, rejected = false) => new IntegrationError('RS.ge', message, rejected)

/* ------------------------------ XML helpers ------------------------------ */

const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unesc = (v: string) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')

/** Raw XML passed as-is inside a parameter (the waybill document). */
class RawXml {
  readonly xml: string
  constructor(xml: string) {
    this.xml = xml
  }
}

/** First <NAME>…</NAME> in xml (namespace prefixes ignored), '' for <NAME/> or when missing. */
function tag(xml: string, name: string): string {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`).exec(xml)
  return m ? unesc((m[1] ?? '').trim()) : ''
}

/** Inner XML of every <NAME>…</NAME> in xml. */
function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1])
}

const el = (name: string, value: string | number | null | undefined) => `<${name}>${value == null ? '' : esc(value)}</${name}>`

/** RS.ge dateTime in Tbilisi time (UTC+4, no DST), e.g. 2026-11-16T14:05:00. */
export function rsDate(d = new Date()): string {
  return new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 19)
}

/** The reverse of rsDate: an RS.ge dateTime as ISO (UTC); undefined when empty. */
function fromRsDate(v: string): string | undefined {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)) return undefined
  const t = Date.parse(`${v}+04:00`)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

const numOf = (v: string) => (v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v))

/* --------------------------------- SOAP --------------------------------- */

type Param = [name: string, value: string | number | RawXml]

/**
 * Calls one operation and returns the inner XML of its <opResponse>. Logs the exchange;
 * `accepted` decides whether a well-formed answer counts as success in the log (RS.ge reports
 * most errors as negative codes inside an HTTP 200). `readBack` tags read-backs in the log.
 */
async function soap(op: string, params: Param[], shipmentId?: string, accepted: (inner: string) => boolean = () => true, readBack?: IntegrationLog['readBack']): Promise<string> {
  const body = params.map(([k, v]) => (v instanceof RawXml ? `<${k}>${v.xml}</${k}>` : el(k, v))).join('')
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><${op} xmlns="${NS}">${body}</${op}></soap:Body></soap:Envelope>`

  // What the log shows: never the password.
  const logged = Object.fromEntries(params.map(([k, v]) => [k, k === 'sp' ? '••••••' : v instanceof RawXml ? v.xml : v]))
  const started = Date.now()
  let raw = ''
  let status = 0
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${NS}${op}"` },
      body: envelope,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = res.status
    raw = await res.text()
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError'
    const message = timeout ? 'RS.ge-მ დროულად არ უპასუხა (timeout)' : `RS.ge მიუწვდომელია: ${(e as Error).message}`
    log({ service: 'RS.ge', direction: 'out', endpoint: LOG_ENDPOINT(op), request: logged, response: { error: message }, ok: false, durationMs: Date.now() - started, shipmentId, readBack })
    throw rsError(message)
  }
  const durationMs = Date.now() - started
  const fault = tag(raw, 'faultstring')
  const m = new RegExp(`<${op}Response[^>]*?(?:/>|>([\\s\\S]*)</${op}Response>)`).exec(raw)
  const ok = status === 200 && !fault && !!m && accepted(m[1] ?? '')
  log({ service: 'RS.ge', direction: 'out', endpoint: LOG_ENDPOINT(op), request: logged, response: { http: status, body: raw.length > 6000 ? raw.slice(0, 6000) + '…' : raw }, ok, durationMs, shipmentId, readBack })
  if (fault) throw rsError(`RS.ge: ${fault}`)
  if (status !== 200 || !m) throw rsError(`RS.ge-მ დააბრუნა მოულოდნელი პასუხი (HTTP ${status})`)
  return m![1] ?? ''
}

const creds = ({ su, sp }: RsCreds): Param[] => [
  ['su', su],
  ['sp', sp],
]

/* ------------------------------ Error codes ------------------------------ */

let errorTexts: Map<number, string> | null = null

/**
 * Human text for an RS.ge error code (get_error_codes, cached). Falls back to the code alone.
 * -101 means "the seller in the XML is not this service user's" for save_waybill, and "someone
 * else's waybill" for the calls that take a waybill ID.
 */
async function describe(code: number, c: RsCreds, op?: string): Promise<string> {
  if (code === -100) return 'RS.ge: სერვისის მომხმარებელი ან პაროლი არასწორია (კოდი -100)'
  if (code === -101 && op === 'save_waybill') return 'RS.ge: გამყიდველი არ ემთხვევა სერვისის მომხმარებელს — RS.ge-ს გვერდზე დააჭირე „კავშირის შემოწმებას“ (კოდი -101)'
  if (code === -101) return 'RS.ge: ზედნადები სხვა გადამხდელს ეკუთვნის (კოდი -101)'
  if (!errorTexts) {
    try {
      const xml = await soap('get_error_codes', creds(c))
      const table = new Map(blocks(xml, 'ERROR_CODE').map((b) => [Number(tag(b, 'ID')), tag(b, 'TEXT')]))
      // A refusal (e.g. <RESULT><STATUS>-100</STATUS>) has no codes: ask again next time.
      if (table.size) errorTexts = table
    } catch {
      /* the code alone is still useful */
    }
  }
  const text = errorTexts?.get(code)
  return text ? `RS.ge: ${text} (კოდი ${code})` : `RS.ge-მ დააბრუნა შეცდომა (კოდი ${code})`
}

/* ------------------------------ Waybill XML ------------------------------ */

/** A goods row as written: a new row (no rsId), an existing one updated by a correction, or one deleted by it. */
export type XmlGood = RsWaybillPayload['goods'][number] & { rsId?: number; deleted?: boolean }

export interface SaveOpts {
  /** Transport start written into the waybill (RS.ge dateTime). */
  beginDate: string
  /** An existing waybill: a draft is overwritten, an active one corrected. */
  id?: number
  /** 0 saved (draft), 1 active (a correction). */
  status?: 0 | 1
  /** Rows to write instead of p.goods: corrections carry row IDs and deleted rows. */
  goods?: XmlGood[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

function waybillXml(p: RsWaybillPayload, seller: { unId: number; userId: number | null }, o: SaveOpts): string {
  const rows: XmlGood[] = o.goods ?? p.goods
  const goods = rows
    .map(
      (g) =>
        `<GOODS>${el('ID', g.rsId ?? 0)}${el('W_NAME', g.name)}${el('UNIT_ID', g.unitId)}${el('UNIT_TXT', g.unitTxt)}${el('QUANTITY', g.quantity)}${el('PRICE', g.price)}` +
        // STATUS -1 deletes the row (corrections only).
        `${el('STATUS', g.deleted ? -1 : 1)}${el('AMOUNT', g.amount)}${el('BAR_CODE', g.barCode)}${el('A_ID', g.aId ?? 0)}${el('VAT_TYPE', g.vatType)}` +
        `${g.quantityExt ? el('QUANTITY_EXT', g.quantityExt) : ''}</GOODS>`,
    )
    .join('')
  const full = round2(rows.filter((g) => !g.deleted).reduce((a, g) => a + g.amount, 0))
  return (
    `<WAYBILL><SUB_WAYBILLS></SUB_WAYBILLS><GOODS_LIST>${goods}</GOODS_LIST>` +
    el('ID', o.id ?? 0) +
    el('TYPE', p.type) +
    el('BUYER_TIN', p.buyerTin) +
    // 1 = Georgian citizen / company, 0 = foreign.
    el('CHEK_BUYER_TIN', p.buyerForeign ? 0 : 1) +
    el('BUYER_NAME', p.buyerName) +
    el('START_ADDRESS', p.startAddress) +
    el('END_ADDRESS', p.endAddress) +
    el('DRIVER_TIN', p.driverTin) +
    el('CHEK_DRIVER_TIN', p.driverForeign ? 0 : 1) +
    el('DRIVER_NAME', p.driverName) +
    el('TRANSPORT_COAST', p.transportCost) +
    el('RECEPTION_INFO', p.receptionInfo) +
    el('RECEIVER_INFO', p.receiverInfo) +
    el('DELIVERY_DATE', '') +
    // 0 = saved (send_waybill activates it); 1 = a correction of an active waybill.
    el('STATUS', o.status ?? 0) +
    el('SELER_UN_ID', seller.unId) +
    el('PAR_ID', '') +
    el('FULL_AMOUNT', full) +
    el('CAR_NUMBER', p.carNumber) +
    el('WAYBILL_NUMBER', '') +
    el('S_USER_ID', seller.userId ?? '') +
    el('BEGIN_DATE', o.beginDate) +
    el('TRAN_COST_PAYER', p.tranCostPayer) +
    el('TRANS_ID', p.transId) +
    el('TRANS_TXT', p.transTxt) +
    el('COMMENT', p.comment) +
    el('CATEGORY', '') +
    el('IS_MED', '') +
    (p.transporterTin ? el('TRANSPORTER_TIN', p.transporterTin) : '') +
    `</WAYBILL>`
  )
}

/** get_waybill leaves UNIT_TXT out for RS.ge's own units: the name is taken from the units list. */
function unitName(unitId: number, txt: string) {
  return txt || account?.units.find((u) => u.id === unitId)?.name || ''
}

const optNum = (v: string) => (v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))

/** A <WAYBILL> from get_waybill. The nested lists are cut out first: their rows have their own ID and STATUS. */
function parseWaybill(xml: string): RsRemoteWaybill {
  const head = xml.replace(/<(GOODS_LIST|SUB_WAYBILLS|WOOD_DOCS_LIST)>[\s\S]*?<\/\1>/g, '')
  const goods = blocks(xml, 'GOODS')
    // STATUS -1 marks a goods row deleted by a correction.
    .filter((g) => tag(g, 'STATUS') !== '-1')
    .map((g) => {
      const unitId = numOf(tag(g, 'UNIT_ID'))
      return {
        id: optNum(tag(g, 'ID')),
        name: tag(g, 'W_NAME'),
        unitId,
        unitTxt: unitName(unitId, tag(g, 'UNIT_TXT')),
        quantity: numOf(tag(g, 'QUANTITY')),
        ...(numOf(tag(g, 'QUANTITY_EXT')) > 0 && { quantityExt: numOf(tag(g, 'QUANTITY_EXT')) }),
        price: numOf(tag(g, 'PRICE')),
        amount: numOf(tag(g, 'AMOUNT')),
        barCode: tag(g, 'BAR_CODE'),
        vatType: numOf(tag(g, 'VAT_TYPE')),
        aId: numOf(tag(g, 'A_ID')),
      }
    })
  const total = tag(head, 'TOTAL_QUANTITY')
  return {
    id: optNum(tag(head, 'ID')),
    type: optNum(tag(head, 'TYPE')),
    status: numOf(tag(head, 'STATUS')),
    number: tag(head, 'WAYBILL_NUMBER'),
    buyerTin: tag(head, 'BUYER_TIN'),
    buyerName: tag(head, 'BUYER_NAME'),
    // CHEK_BUYER_TIN: 1 Georgian, 0 foreign.
    buyerForeign: tag(head, 'CHEK_BUYER_TIN') === '0',
    sellerTin: tag(head, 'SELLER_TIN'),
    sellerName: tag(head, 'SELLER_NAME'),
    startAddress: tag(head, 'START_ADDRESS'),
    endAddress: tag(head, 'END_ADDRESS'),
    driverTin: tag(head, 'DRIVER_TIN'),
    driverName: tag(head, 'DRIVER_NAME'),
    carNumber: tag(head, 'CAR_NUMBER'),
    transportCost: numOf(tag(head, 'TRANSPORT_COAST')),
    transId: optNum(tag(head, 'TRANS_ID')),
    transTxt: tag(head, 'TRANS_TXT'),
    tranCostPayer: optNum(tag(head, 'TRAN_COST_PAYER')),
    transporterTin: tag(head, 'TRANSPORTER_TIN'),
    receptionInfo: tag(head, 'RECEPTION_INFO'),
    receiverInfo: tag(head, 'RECEIVER_INFO'),
    fullAmount: numOf(tag(head, 'FULL_AMOUNT')),
    fullAmountText: tag(head, 'FULL_AMOUNT_TXT'),
    quantity: total !== '' ? numOf(total) : Math.round(goods.reduce((a, g) => a + g.quantity, 0) * 1000) / 1000,
    goods,
    comment: tag(head, 'COMMENT'),
    invoiceId: numOf(tag(head, 'INVOICE_ID')) || undefined,
    confirmed: numOf(tag(head, 'IS_CONFIRMED')),
    createdAt: fromRsDate(tag(head, 'CREATE_DATE')),
    activatedAt: fromRsDate(tag(head, 'ACTIVATE_DATE')),
    beginAt: fromRsDate(tag(head, 'BEGIN_DATE')),
    deliveredAt: fromRsDate(tag(head, 'DELIVERY_DATE')),
    closedAt: fromRsDate(tag(head, 'CLOSE_DATE')),
    correctedAt: fromRsDate(tag(head, 'CORRECTION_DATE')),
    checkedAt: new Date().toISOString(),
  }
}

/** A row of get_waybills / get_buyer_waybills. The seller's own list has no seller fields: they are ours. */
function parseListRow(b: string, own: { tin: string; name: string }): RsListWaybill {
  return {
    id: numOf(tag(b, 'ID')),
    type: numOf(tag(b, 'TYPE')),
    status: numOf(tag(b, 'STATUS')),
    number: tag(b, 'WAYBILL_NUMBER'),
    createdAt: fromRsDate(tag(b, 'CREATE_DATE')),
    activatedAt: fromRsDate(tag(b, 'ACTIVATE_DATE')),
    beginAt: fromRsDate(tag(b, 'BEGIN_DATE')),
    closedAt: fromRsDate(tag(b, 'CLOSE_DATE')),
    deliveredAt: fromRsDate(tag(b, 'DELIVERY_DATE')),
    buyerTin: tag(b, 'BUYER_TIN'),
    buyerName: tag(b, 'BUYER_NAME'),
    sellerTin: tag(b, 'SELLER_TIN') || own.tin,
    sellerName: tag(b, 'SELLER_NAME') || own.name,
    startAddress: tag(b, 'START_ADDRESS'),
    endAddress: tag(b, 'END_ADDRESS'),
    driverTin: tag(b, 'DRIVER_TIN'),
    driverName: tag(b, 'DRIVER_NAME'),
    carNumber: tag(b, 'CAR_NUMBER'),
    fullAmount: numOf(tag(b, 'FULL_AMOUNT')),
    comment: tag(b, 'WAYBILL_COMMENT') || tag(b, 'COMMENT'),
    confirmed: numOf(tag(b, 'IS_CONFIRMED')),
    corrected: tag(b, 'IS_CORRECTED') === '1',
  }
}

/* ------------------------------ Operations ------------------------------ */

const live = {
  /** chek_service_user + seller details + reference lists. */
  async check(c: RsCreds) {
    const xml = await soap('chek_service_user', creds(c), undefined, (x) => tag(x, 'chek_service_userResult') === 'true')
    const valid = tag(xml, 'chek_service_userResult') === 'true'
    const unId = Number(tag(xml, 'un_id'))
    const userId = Number(tag(xml, 's_user_id'))
    if (!valid || !(unId > 0)) {
      // A common mix-up: the rs.ge portal login (e.g. the protocol's test "tbilisi" / 123456) is
      // not a service user. If these credentials open the portal account, say so and list the
      // service users that exist on it (they look like NAME:TIN).
      const users = await soap('get_service_users', [['user_name', c.su], ['user_password', c.sp]])
        .then((x) => blocks(x, 'ServiceUser').map((b) => tag(b, 'USER_NAME')).filter(Boolean))
        .catch(() => [] as string[])
      if (users.length) {
        const sample = users.slice(0, 3).join(', ')
        throw rsError(
          `RS.ge: ეს არის rs.ge-ს პორტალის მომხმარებელი, არა სერვისის მომხმარებელი. ` +
            `ზედნადებებისთვის საჭიროა სერვისის მომხმარებელი ფორმატით „სახელი:საიდენტიფიკაციო“ (მაგ. ${sample}) და მისი პაროლი. ` +
            `შექმენი eservices.rs.ge-ზე → მომხმარებლები → სერვისის მომხმარებლები.`,
        )
      }
      if (!c.su.includes(':')) throw rsError('RS.ge: სერვისის მომხმარებელი ან პაროლი არასწორია — სერვისის მომხმარებლის სახელი ასე გამოიყურება: „სახელი:საიდენტიფიკაციო“')
      throw rsError('RS.ge: სერვისის მომხმარებელი ან პაროლი არასწორია')
    }
    const tinXml = await soap('get_tin_from_un_id', [...creds(c), ['un_id', unId]])
    const list = async (op: string, item: string): Promise<RsRefItem[]> =>
      blocks(await soap(op, creds(c)), item)
        .map((b) => ({ id: Number(tag(b, 'ID')), name: tag(b, 'NAME') }))
        .filter((x) => Number.isFinite(x.id) && x.name)
    return {
      unId,
      userId: userId > 0 ? userId : null,
      tin: tag(tinXml, 'get_tin_from_un_idResult'),
      name: tag(tinXml, 'name'),
      units: await list('get_waybill_units', 'WAYBILL_UNIT'),
      // Not needed to connect: an empty list is loaded again later.
      akciz: await live.akciz(c).catch(() => [] as RsAkciz[]),
    }
  },

  /** Excise goods codes (get_akciz_codes). Tagged as a read-back in the log. */
  async akciz(c: RsCreds): Promise<RsAkciz[]> {
    const xml = await soap('get_akciz_codes', creds(c), undefined, (x) => /<AKCIZ_CODE[\s>]/.test(x), 'sync')
    return blocks(xml, 'AKCIZ_CODE')
      .map((b) => ({ id: Number(tag(b, 'ID')), title: tag(b, 'TITLE'), unit: tag(b, 'MEASUREMENT'), code: tag(b, 'SAKON_KODI'), rate: tag(b, 'AKCIS_GANAKV') }))
      .filter((x) => x.id > 0 && x.title)
  },

  /** '' when RS.ge doesn't know the number (it answers with the literal text "null"). */
  async nameFromTin(c: RsCreds, tin: string) {
    const name = tag(await soap('get_name_from_tin', [...creds(c), ['tin', tin]], undefined, (x) => !/^(null)?$/i.test(tag(x, 'get_name_from_tinResult'))), 'get_name_from_tinResult')
    return /^null$/i.test(name) ? '' : name
  },

  async saveWaybill(c: RsCreds, seller: { unId: number; userId: number | null }, p: RsWaybillPayload, shipmentId: string | undefined, o: SaveOpts): Promise<number> {
    const xml = await soap('save_waybill', [...creds(c), ['waybill', new RawXml(waybillXml(p, seller, o))]], shipmentId, (x) => Number(tag(x, 'STATUS')) >= 0 && Number(tag(x, 'ID')) > 0)
    const status = Number(tag(xml, 'STATUS'))
    const id = Number(tag(xml, 'ID'))
    if (status < 0 || !(id > 0)) {
      // Item-level errors come back per GOODS row.
      const goodsErr = blocks(xml, 'GOODS')
        .map((g) => Number(tag(g, 'ERROR')))
        .find((n) => n < 0)
      throw rsError(await describe(status < 0 ? status : (goodsErr ?? status), c, 'save_waybill'), true)
    }
    return id
  },

  /**
   * Activates a saved waybill and returns its number. send_waybil_vd (sic, one "l") sets the
   * transport start to now; plain send_waybill would keep the time of save_waybill, which is wrong
   * when activation is retried later. An already active waybill answers -1 (see activate in logic.ts).
   */
  async sendWaybill(c: RsCreds, waybillId: number, shipmentId: string | undefined, begin?: Date): Promise<string> {
    const send = async (op: 'send_waybil_vd' | 'send_waybill', extra: Param[]) =>
      tag(await soap(op, [...creds(c), ...extra, ['waybill_id', waybillId]], shipmentId, (x) => /^[^-]/.test(tag(x, `${op}Result`))), `${op}Result`)
    // A planned start still ahead is kept; one already passed (a late activation) becomes now.
    const start = begin && begin.getTime() > Date.now() ? begin : new Date()
    let number = await send('send_waybil_vd', [['begin_date', rsDate(start)]])
    // -1034: start before the waybill's creation time (our clock behind RS.ge's) → let RS.ge pick it.
    if (number === '-1034' && start.getTime() - Date.now() < 60_000) number = await send('send_waybill', [])
    if (!number || /^-\d+$/.test(number)) throw rsError(await describe(Number(number) || -1, c))
    return number
  },

  /**
   * Sends a saved waybill with a transport company (TRANS_ID 7, TRANSPORTER_TIN) to that company
   * (send_waybill_transporter → status 8): the company fills in the driver and vehicle and activates
   * it. Returns the number when RS.ge gives one already ('' otherwise: it is read back later).
   */
  async sendToTransporter(c: RsCreds, waybillId: number, shipmentId: string | undefined, begin?: Date): Promise<string> {
    const op = 'send_waybill_transporter'
    // A planned start still ahead is kept; one already passed becomes now.
    const start = begin && begin.getTime() > Date.now() ? begin : new Date()
    const xml = await soap(op, [...creds(c), ['waybill_id', waybillId], ['begin_date', rsDate(start)]], shipmentId, (x) => Number(tag(x, `${op}Result`)) > 0)
    const result = Number(tag(xml, `${op}Result`))
    if (!(result > 0)) throw rsError(await describe(result || -1, c))
    return tag(xml, 'waybill_number')
  },

  /**
   * Waybills of this taxpayer last changed between `from` and `to` (get_waybills_v1; at most 3 days;
   * saved drafts are listed too). Returns the one whose comment carries `ref`, or null when there is none.
   * No buyer filter: the buyer in the settings may have changed since the earlier attempt.
   */
  async findByRef(c: RsCreds, ref: string, from: Date, to: Date, shipmentId: string): Promise<FoundWaybill | null> {
    const xml = await soap('get_waybills_v1', [...creds(c), ['last_update_date_s', rsDate(from)], ['last_update_date_e', rsDate(to)]], shipmentId)
    // An error comes back as a bare negative number instead of a list.
    const bare = tag(xml, 'get_waybills_v1Result')
    if (/^-\d+$/.test(bare)) throw rsError(await describe(Number(bare), c))
    for (const b of blocks(xml, 'WAYBILL')) {
      const comment = tag(b, 'WAYBILL_COMMENT') || tag(b, 'COMMENT')
      if (!comment.includes(ref)) continue
      return { id: Number(tag(b, 'ID')), status: Number(tag(b, 'STATUS')), number: tag(b, 'WAYBILL_NUMBER') }
    }
    return null
  },

  /** One waybill as RS.ge has it now. */
  async getWaybill(c: RsCreds, waybillId: number, shipmentId: string | undefined, via?: IntegrationLog['readBack']): Promise<RsRemoteWaybill> {
    const xml = await soap('get_waybill', [...creds(c), ['waybill_id', waybillId]], shipmentId, (x) => /<WAYBILL[\s>]/.test(x), via)
    const [b] = blocks(xml, 'WAYBILL')
    // Errors come back as <RESULT><STATUS>-101</STATUS>…</RESULT>.
    if (!b) throw rsError(await describe(numOf(tag(xml, 'STATUS')) || -1, c))
    const w = parseWaybill(b)
    if (numOf(tag(b.replace(/<(GOODS_LIST|SUB_WAYBILLS|WOOD_DOCS_LIST)>[\s\S]*?<\/\1>/g, ''), 'ID')) !== waybillId) throw rsError('RS.ge-მ სხვა ზედნადები დააბრუნა')
    return w
  },

  /**
   * IDs of this taxpayer's waybills (sold or bought) last changed between `from` and `to`
   * (get_waybills_v1; at most 3 days). Used by the background sync. Without a buyer filter, so a
   * waybill whose buyer was corrected on the rs.ge portal is still seen.
   */
  async changed(c: RsCreds, from: Date, to: Date): Promise<{ id: number; status: number; sellerTin: string }[]> {
    const xml = await soap('get_waybills_v1', [...creds(c), ['last_update_date_s', rsDate(from)], ['last_update_date_e', rsDate(to)]], undefined, (x) => !/^-\d+$/.test(tag(x, 'get_waybills_v1Result')), 'sync')
    const bare = tag(xml, 'get_waybills_v1Result')
    if (/^-\d+$/.test(bare)) throw rsError(await describe(Number(bare), c))
    return blocks(xml, 'WAYBILL').map((b) => ({ id: Number(tag(b, 'ID')), status: Number(tag(b, 'STATUS')), sellerTin: tag(b, 'SELLER_TIN') }))
  },

  /**
   * The taxpayer's product list: all of it for an empty `filter`, otherwise the codes containing it
   * (RS.ge matches parts of codes, not whole ones). Tagged as a read-back in the log.
   */
  async barCodes(c: RsCreds, filter = ''): Promise<RsBarCode[]> {
    const xml = await soap('get_bar_codes', [...creds(c), ['bar_code', filter]], undefined, (x) => tag(x, 'get_bar_codesResult') === '1', 'sync')
    const r = Number(tag(xml, 'get_bar_codesResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c))
    return blocks(xml, 'BAR_CODE')
      .map((b) => ({ barCode: tag(b, 'CODE'), name: tag(b, 'NAME'), unitId: numOf(tag(b, 'UNIT_ID')), unitTxt: tag(b, 'UNIT_TXT'), aId: numOf(tag(b, 'A_ID')) }))
      .filter((x) => x.barCode)
  },

  /** Adds the product to RS.ge, or overwrites the one with the same bar code. */
  async saveBarCode(c: RsCreds, p: RsBarCode) {
    const params: Param[] = [...creds(c), ['bar_code', p.barCode], ['goods_name', p.name], ['unit_id', p.unitId], ['unit_txt', p.unitTxt], ['a_id', p.aId]]
    const r = Number(tag(await soap('save_bar_code', params, undefined, (x) => tag(x, 'save_bar_codeResult') === '1'), 'save_bar_codeResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c), true)
  },

  async deleteBarCode(c: RsCreds, barCode: string) {
    const r = Number(tag(await soap('delete_bar_code', [...creds(c), ['bar_code', barCode]], undefined, (x) => tag(x, 'delete_bar_codeResult') === '1'), 'delete_bar_codeResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c), true)
  },

  /** The taxpayer's car numbers, as RS.ge stores them (no dashes). Tagged as a read-back in the log. */
  async carNumbers(c: RsCreds): Promise<string[]> {
    const xml = await soap('get_car_numbers', creds(c), undefined, (x) => tag(x, 'get_car_numbersResult') === '1', 'sync')
    const r = Number(tag(xml, 'get_car_numbersResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c))
    return blocks(xml, 'CAR_NUMBER').map((b) => unesc(b.trim())).filter(Boolean)
  },

  async saveCarNumber(c: RsCreds, carNumber: string) {
    const r = Number(tag(await soap('save_car_numbers', [...creds(c), ['car_number', carNumber]], undefined, (x) => tag(x, 'save_car_numbersResult') === '1'), 'save_car_numbersResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c), true)
  },

  async deleteCarNumber(c: RsCreds, carNumber: string) {
    const r = Number(tag(await soap('delete_car_numbers', [...creds(c), ['car_number', carNumber]], undefined, (x) => tag(x, 'delete_car_numbersResult') === '1'), 'delete_car_numbersResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c), true)
  },

  /** close_waybill / ref_waybill / del_waybill return 1 on success, 0 or a negative code otherwise. */
  async finish(op: 'close_waybill' | 'ref_waybill' | 'del_waybill', c: RsCreds, waybillId: number, shipmentId: string | undefined) {
    const r = Number(tag(await soap(op, [...creds(c), ['waybill_id', waybillId]], shipmentId, (x) => tag(x, `${op}Result`) === '1'), `${op}Result`))
    if (r !== 1) throw rsError(await describe(r || -1, c, op))
  },

  /** Completes the waybill with the date the goods were delivered (close_waybill_vd). */
  async closeOn(c: RsCreds, waybillId: number, delivered: Date, shipmentId: string | undefined) {
    const op = 'close_waybill_vd'
    const r = Number(tag(await soap(op, [...creds(c), ['delivery_date', rsDate(delivered)], ['waybill_id', waybillId]], shipmentId, (x) => tag(x, `${op}Result`) === '1'), `${op}Result`))
    // -1 here is usually a delivery date before the start of transport (-1018) or in the future (-1017).
    if (r === -1) throw rsError('RS.ge-მ ზედნადები არ დაასრულა — მიწოდების თარიღი უნდა იყოს ტრანსპორტირების დაწყების შემდეგ და არა მომავალში (კოდი -1)')
    if (r !== 1) throw rsError(await describe(r || -1, c, op))
  },

  /** Writes a tax invoice (ანგარიშ-ფაქტურა) from the waybill (save_invoice) and returns its ID. */
  async saveInvoice(c: RsCreds, waybillId: number, shipmentId: string | undefined): Promise<number> {
    const xml = await soap('save_invoice', [...creds(c), ['waybill_id', waybillId], ['in_inv_id', 0]], shipmentId, (x) => tag(x, 'save_invoiceResult') === '1')
    const r = Number(tag(xml, 'save_invoiceResult'))
    const inv = Number(tag(xml, 'out_inv_id'))
    if (r !== 1 || !(inv > 0)) {
      // -3009: RS.ge's answer when the waybill already has an invoice (or can't have one).
      if (r === -3009) throw rsError('RS.ge-მ ანგარიშ-ფაქტურა არ გამოწერა — ამ ზედნადებზე ის უკვე გამოწერილია, ან ზედნადები არ არის აქტიური (კოდი -3009)', true)
      throw rsError(await describe(r || -1, c), true)
    }
    return inv
  },

  /** The buyer's answer to a received waybill: მივიღე (confirm_waybill) or არ ვეთანხმები (reject_waybill). */
  async answer(c: RsCreds, waybillId: number, accept: boolean) {
    const op = accept ? 'confirm_waybill' : 'reject_waybill'
    const ok = tag(await soap(op, [...creds(c), ['waybill_id', waybillId]], undefined, (x) => tag(x, `${op}Result`) === 'true'), `${op}Result`) === 'true'
    if (!ok) throw rsError(accept ? 'RS.ge-მ ზედნადები არ დაადასტურა' : 'RS.ge-მ ზედნადები არ უარყო')
  },

  /**
   * Waybills created between `from` and `to` (at most 72 hours, code -1064): issued (get_waybills) or
   * received (get_buyer_waybills). Dates left out are sent as missing elements: RS.ge refuses empty ones.
   */
  async list(c: RsCreds, side: 'issued' | 'received', from: Date, to: Date, own: { tin: string; name: string }): Promise<RsListWaybill[]> {
    const op = side === 'issued' ? 'get_waybills' : 'get_buyer_waybills'
    const params: Param[] = [
      ...creds(c),
      ['itypes', ''],
      [side === 'issued' ? 'buyer_tin' : 'seller_tin', ''],
      ['statuses', ''],
      ['car_number', ''],
      ['create_date_s', rsDate(from)],
      ['create_date_e', rsDate(to)],
      ['driver_tin', ''],
      ['waybill_number', ''],
      ['s_user_ids', ''],
      ['comment', ''],
    ]
    const xml = await soap(op, params, undefined, (x) => !/^-\d+$/.test(tag(x, `${op}Result`)), 'page')
    const bare = tag(xml, `${op}Result`)
    if (/^-\d+$/.test(bare)) throw rsError(await describe(Number(bare), c))
    return blocks(xml, 'WAYBILL').map((b) => parseListRow(b, own))
  },
}

/* -------------------------------- Facade -------------------------------- */

/** The service user from .env (RS_SERVICE_USER / RS_SERVICE_PASSWORD). */
export function storedCreds(): RsCreds | null {
  return RS_SU && RS_SP ? { su: RS_SU, sp: RS_SP } : null
}

function activeCreds(): RsCreds {
  const c = storedCreds()
  if (!c) throw rsError('RS.ge: სერვისის მომხმარებელი ან პაროლი არ არის მითითებული — მიმართე ადმინისტრატორს')
  return c
}

/* The service user as RS.ge describes it: memory only, read again after a restart. */
let account: RsAccount | null = null
let accountLoad: Promise<RsAccount> | null = null
/** Why the account info couldn't be read the last time it was tried. */
let accountError: string | undefined
let accountListener = () => {}

/** Called whenever the account info (or its error) changes: the API's state revision follows it. */
export function onAccountChange(fn: () => void) {
  accountListener = fn
}

function setAccount(a: RsAccount | null) {
  account = a
  accountError = undefined
  accountListener()
}

/** Seller IDs of the service user: known since connecting, or looked up now. */
async function seller(C: RsCreds) {
  const a = await rsge.loadAccount(C)
  return { unId: a.unId, userId: a.userId }
}

/** get_waybills_v1 accepts at most 3 days; a minute less to stay clear of the edge. */
const WINDOW_MS = 3 * 86400_000 - 60_000
/** get_waybills / get_buyer_waybills accept at most 72 hours of creation dates (code -1064). */
const LIST_WINDOW_MS = 72 * 3600_000 - 60_000

export const rsge = {
  check: (c: RsCreds) => live.check(c),

  /** The account info for the stored service user, if it has been read since the server started. */
  account: (): RsAccount | null => (account && account.su === RS_SU ? account : null),
  accountError: () => accountError,

  /** Records what a successful check returned (connecting). */
  setAccount(su: string, r: Awaited<ReturnType<typeof live.check>>) {
    setAccount({ su, unId: r.unId, userId: r.userId, tin: r.tin, name: r.name, units: r.units, akciz: r.akciz, checkedAt: new Date().toISOString() })
  },

  /** The account info, read from RS.ge when it isn't known yet. One read at a time. */
  async loadAccount(c: RsCreds = activeCreds()): Promise<RsAccount> {
    const known = rsge.account()
    if (known && known.su === c.su) return known
    accountLoad ??= live
      .check(c)
      .then((r) => {
        rsge.setAccount(c.su, r)
        return account!
      })
      .catch((e: Error) => {
        accountError = e.message
        accountListener()
        throw e
      })
      .finally(() => (accountLoad = null))
    return accountLoad
  },

  /** Excise codes again, when connecting couldn't load them. */
  async reloadAkciz() {
    const a = rsge.account()
    if (!a || a.akciz.length) return
    const akciz = await live.akciz(activeCreds())
    if (akciz.length && rsge.account() === a) setAccount({ ...a, akciz })
  },
  nameFromTin: (c: RsCreds, tin: string) => live.nameFromTin(c, tin),

  /**
   * Saves the waybill on RS.ge and returns its ID: a new one (status: saved), or, with `o.id`, a draft
   * overwritten or an active waybill corrected.
   */
  async saveWaybill(p: RsWaybillPayload, shipmentId: string | undefined, o: SaveOpts = { beginDate: rsDate() }): Promise<number> {
    const c = activeCreds()
    return live.saveWaybill(c, await seller(c), p, shipmentId, o)
  },

  /**
   * Looks for the waybill an earlier save_waybill may have created even though its answer never
   * arrived (timeout, dropped connection, restart). `ref` is the shipment's tag in COMMENT.
   */
  async findByRef(ref: string, since: Date, shipmentId: string) {
    const c = activeCreds()
    const from = new Date(since.getTime() - 10 * 60_000)
    const to = new Date(Math.min(Date.now() + 10 * 60_000, from.getTime() + WINDOW_MS))
    // A draft changed later (e.g. activated on the portal) has a newer update time: look at the last 3 days too.
    const recent = to.getTime() < Date.now() ? live.findByRef(c, ref, new Date(Date.now() - WINDOW_MS), new Date(Date.now() + 60_000), shipmentId) : null
    return (await live.findByRef(c, ref, from, to, shipmentId)) ?? (await recent)
  },

  /** Activates a saved waybill and returns its number. `begin`: a planned start of transport (up to 3 days ahead). */
  sendWaybill: (waybillId: number, shipmentId: string | undefined, begin?: Date) => live.sendWaybill(activeCreds(), waybillId, shipmentId, begin),
  sendToTransporter: (waybillId: number, shipmentId: string | undefined, begin?: Date) => live.sendToTransporter(activeCreds(), waybillId, shipmentId, begin),

  /** Completes the waybill (goods delivered), now or on the date given. */
  closeWaybill: (waybillId: number, shipmentId: string | undefined, delivered?: Date) =>
    delivered ? live.closeOn(activeCreds(), waybillId, delivered, shipmentId) : live.finish('close_waybill', activeCreds(), waybillId, shipmentId),

  /** Cancels an activated or completed waybill. */
  cancelWaybill: (waybillId: number, shipmentId: string | undefined) => live.finish('ref_waybill', activeCreds(), waybillId, shipmentId),

  /** Deletes a saved draft (never activated). */
  deleteWaybill: (waybillId: number, shipmentId: string | undefined) => live.finish('del_waybill', activeCreds(), waybillId, shipmentId),

  /** Writes a tax invoice from an active or completed waybill; returns the invoice ID. */
  saveInvoice: (waybillId: number, shipmentId: string | undefined) => live.saveInvoice(activeCreds(), waybillId, shipmentId),

  /** The buyer confirms (მივიღე) or rejects (არ ვეთანხმები) a received waybill. */
  answer: (waybillId: number, accept: boolean) => live.answer(activeCreds(), waybillId, accept),

  /** The waybill as RS.ge has it now. `via` tags read-backs in the log; omitted when part of an upload. */
  getWaybill: (waybillId: number, shipmentId: string | undefined, via?: IntegrationLog['readBack']) => live.getWaybill(activeCreds(), waybillId, shipmentId, via),

  /**
   * Issued or received waybills created between `from` and `to`, read in windows of 72 hours (the RS.ge
   * limit), newest first. A waybill that falls on a window's edge is listed once.
   */
  async list(side: 'issued' | 'received', from: Date, to: Date): Promise<RsListWaybill[]> {
    const c = activeCreds()
    const a = await rsge.loadAccount(c)
    const own = { tin: a.tin, name: a.name }
    const windows: [Date, Date][] = []
    for (let e = to.getTime(); e > from.getTime(); e -= LIST_WINDOW_MS) windows.push([new Date(Math.max(from.getTime(), e - LIST_WINDOW_MS)), new Date(e)])
    const out = new Map<number, RsListWaybill>()
    // A few windows at a time: fast, without flooding RS.ge.
    for (let i = 0; i < windows.length; i += 3) {
      const parts = await Promise.all(windows.slice(i, i + 3).map(([a, b]) => live.list(c, side, a, b, own)))
      for (const w of parts.flat()) out.set(w.id, w)
    }
    return [...out.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id - a.id)
  },

  /** The taxpayer's product list on RS.ge. */
  barCodes: () => live.barCodes(activeCreds()),
  /** Excise goods codes. */
  akciz: () => live.akciz(activeCreds()),
  /** One product on RS.ge by its exact bar code, or null when RS.ge doesn't have it. */
  async barCode(barCode: string): Promise<RsBarCode | null> {
    return (await live.barCodes(activeCreds(), barCode)).find((x) => x.barCode === barCode) ?? null
  },
  /** Adds or overwrites a product on RS.ge. Its answer can't be trusted on its own: check with barCode(). */
  saveBarCode: (p: RsBarCode) => live.saveBarCode(activeCreds(), p),
  /** Removes a product from RS.ge. */
  deleteBarCode: (barCode: string) => live.deleteBarCode(activeCreds(), barCode),

  /** The taxpayer's car numbers on RS.ge. */
  carNumbers: () => live.carNumbers(activeCreds()),
  /** Adds a car number to RS.ge's list. Check with carNumbers(): like bar codes, the answer alone isn't proof. */
  saveCarNumber: (carNumber: string) => live.saveCarNumber(activeCreds(), carNumber),
  /** Removes a car number from RS.ge's list. */
  deleteCarNumber: (carNumber: string) => live.deleteCarNumber(activeCreds(), carNumber),

  /** IDs of waybills changed between `from` and `to`, read in 3-day windows (the RS.ge limit). */
  async changed(from: Date, to: Date) {
    const c = activeCreds()
    const out: { id: number; status: number; sellerTin: string }[] = []
    for (let s = from.getTime(); s < to.getTime(); s += WINDOW_MS) {
      out.push(...(await live.changed(c, new Date(s), new Date(Math.min(s + WINDOW_MS, to.getTime())))))
    }
    return out
  },
}

/** Forget cached error texts and the account info (after changing or removing the service user). */
export function resetRsCache() {
  errorTexts = null
  accountLoad = null
  setAccount(null)
}

