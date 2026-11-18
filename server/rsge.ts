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
 * Products: the taxpayer's product list on RS.ge (get_bar_codes / save_bar_code / delete_bar_code,
 * "სასაქონლო კოდების აღრიცხვა"). save_bar_code adds or overwrites by bar code; delete_bar_code
 * also answers 1 for a code that isn't there. save_bar_code also answers 1 for codes it silently
 * doesn't store (common ones like 67, 123 or asd, apparently because another taxpayer already has
 * them), so a save is only trusted after reading the code back.
 *
 * RS.ge has no separate sandbox host: testing is done on the normal endpoint with a test
 * service user. The service user (su / sp) is entered by the admin and stored on the server,
 * the password encrypted (server/secret.ts). Every call goes to the integration log, with the
 * password masked. Read-backs are tagged
 * (readBack) so the log keeps them apart from the uploads.
 */
import type { IntegrationLog, RsRefItem, RsRemoteWaybill, RsWaybillPayload } from '../src/types.ts'
import { IntegrationError, log } from './integrations.ts'
import { store as db } from './store.ts'

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

function waybillXml(p: RsWaybillPayload, seller: { unId: number; userId: number | null }, beginDate: string): string {
  const goods = p.goods
    .map(
      (g) =>
        `<GOODS>${el('ID', 0)}${el('W_NAME', g.name)}${el('UNIT_ID', g.unitId)}${el('UNIT_TXT', g.unitTxt)}${el('QUANTITY', g.quantity)}${el('PRICE', g.price)}` +
        `${el('STATUS', 1)}${el('AMOUNT', g.amount)}${el('BAR_CODE', g.barCode)}${el('A_ID', 0)}${el('VAT_TYPE', g.vatType)}</GOODS>`,
    )
    .join('')
  const full = Math.round(p.goods.reduce((a, g) => a + g.amount, 0) * 100) / 100
  return (
    `<WAYBILL><SUB_WAYBILLS></SUB_WAYBILLS><GOODS_LIST>${goods}</GOODS_LIST>` +
    el('ID', 0) +
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
    // 0 = saved; send_waybill activates it.
    el('STATUS', 0) +
    el('SELER_UN_ID', seller.unId) +
    el('PAR_ID', '') +
    el('FULL_AMOUNT', full) +
    el('CAR_NUMBER', p.carNumber) +
    el('WAYBILL_NUMBER', '') +
    el('S_USER_ID', seller.userId ?? '') +
    el('BEGIN_DATE', beginDate) +
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

/** A <WAYBILL> from get_waybill. The nested lists are cut out first: their rows have their own ID and STATUS. */
function parseWaybill(xml: string): RsRemoteWaybill {
  const head = xml.replace(/<(GOODS_LIST|SUB_WAYBILLS|WOOD_DOCS_LIST)>[\s\S]*?<\/\1>/g, '')
  const goods = blocks(xml, 'GOODS')
    // STATUS -1 marks a goods row deleted by a correction.
    .filter((g) => tag(g, 'STATUS') !== '-1')
    .map((g) => ({
      name: tag(g, 'W_NAME'),
      unitTxt: tag(g, 'UNIT_TXT'),
      quantity: numOf(tag(g, 'QUANTITY')),
      price: numOf(tag(g, 'PRICE')),
      amount: numOf(tag(g, 'AMOUNT')),
      barCode: tag(g, 'BAR_CODE'),
    }))
  const total = tag(head, 'TOTAL_QUANTITY')
  return {
    status: numOf(tag(head, 'STATUS')),
    number: tag(head, 'WAYBILL_NUMBER'),
    buyerTin: tag(head, 'BUYER_TIN'),
    buyerName: tag(head, 'BUYER_NAME'),
    startAddress: tag(head, 'START_ADDRESS'),
    endAddress: tag(head, 'END_ADDRESS'),
    driverTin: tag(head, 'DRIVER_TIN'),
    driverName: tag(head, 'DRIVER_NAME'),
    carNumber: tag(head, 'CAR_NUMBER'),
    transportCost: numOf(tag(head, 'TRANSPORT_COAST')),
    fullAmount: numOf(tag(head, 'FULL_AMOUNT')),
    quantity: total !== '' ? numOf(total) : Math.round(goods.reduce((a, g) => a + g.quantity, 0) * 1000) / 1000,
    goods,
    comment: tag(head, 'COMMENT'),
    activatedAt: fromRsDate(tag(head, 'ACTIVATE_DATE')),
    beginAt: fromRsDate(tag(head, 'BEGIN_DATE')),
    deliveredAt: fromRsDate(tag(head, 'DELIVERY_DATE')),
    closedAt: fromRsDate(tag(head, 'CLOSE_DATE')),
    correctedAt: fromRsDate(tag(head, 'CORRECTION_DATE')),
    checkedAt: new Date().toISOString(),
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
      transTypes: await list('get_trans_types', 'TRANSPORT_TYPE'),
    }
  },

  /** '' when RS.ge doesn't know the number (it answers with the literal text "null"). */
  async nameFromTin(c: RsCreds, tin: string) {
    const name = tag(await soap('get_name_from_tin', [...creds(c), ['tin', tin]], undefined, (x) => !/^(null)?$/i.test(tag(x, 'get_name_from_tinResult'))), 'get_name_from_tinResult')
    return /^null$/i.test(name) ? '' : name
  },

  async saveWaybill(c: RsCreds, seller: { unId: number; userId: number | null }, p: RsWaybillPayload, shipmentId: string): Promise<number> {
    const xml = await soap('save_waybill', [...creds(c), ['waybill', new RawXml(waybillXml(p, seller, rsDate()))]], shipmentId, (x) => Number(tag(x, 'STATUS')) >= 0 && Number(tag(x, 'ID')) > 0)
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
  async sendWaybill(c: RsCreds, waybillId: number, shipmentId: string): Promise<string> {
    const send = async (op: 'send_waybil_vd' | 'send_waybill', extra: Param[]) =>
      tag(await soap(op, [...creds(c), ...extra, ['waybill_id', waybillId]], shipmentId, (x) => /^[^-]/.test(tag(x, `${op}Result`))), `${op}Result`)
    let number = await send('send_waybil_vd', [['begin_date', rsDate()]])
    // -1034: start before the waybill's creation time (our clock behind RS.ge's) → let RS.ge pick it.
    if (number === '-1034') number = await send('send_waybill', [])
    if (!number || /^-\d+$/.test(number)) throw rsError(await describe(Number(number) || -1, c))
    return number
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
  async getWaybill(c: RsCreds, waybillId: number, shipmentId: string | undefined, via?: 'sync' | 'page'): Promise<RsRemoteWaybill> {
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
      .map((b) => ({ barCode: tag(b, 'CODE'), name: tag(b, 'NAME'), unitId: numOf(tag(b, 'UNIT_ID')), unitTxt: tag(b, 'UNIT_TXT') }))
      .filter((x) => x.barCode)
  },

  /** Adds the product to RS.ge, or overwrites the one with the same bar code. */
  async saveBarCode(c: RsCreds, p: RsBarCode) {
    const params: Param[] = [...creds(c), ['bar_code', p.barCode], ['goods_name', p.name], ['unit_id', p.unitId], ['unit_txt', p.unitTxt], ['a_id', 0]]
    const r = Number(tag(await soap('save_bar_code', params, undefined, (x) => tag(x, 'save_bar_codeResult') === '1'), 'save_bar_codeResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c), true)
  },

  async deleteBarCode(c: RsCreds, barCode: string) {
    const r = Number(tag(await soap('delete_bar_code', [...creds(c), ['bar_code', barCode]], undefined, (x) => tag(x, 'delete_bar_codeResult') === '1'), 'delete_bar_codeResult'))
    if (r !== 1) throw rsError(await describe(r || -1, c), true)
  },

  /** close_waybill / ref_waybill / del_waybill return 1 on success, 0 or a negative code otherwise. */
  async finish(op: 'close_waybill' | 'ref_waybill' | 'del_waybill', c: RsCreds, waybillId: number, shipmentId: string) {
    const r = Number(tag(await soap(op, [...creds(c), ['waybill_id', waybillId]], shipmentId, (x) => tag(x, `${op}Result`) === '1'), `${op}Result`))
    if (r !== 1) throw rsError(await describe(r || -1, c, op))
  },
}

/* -------------------------------- Facade -------------------------------- */

/** The service user the admin connected. */
export function storedCreds(): RsCreds | null {
  const rs = db.get().rs
  return rs.su && rs.sp ? { su: rs.su, sp: rs.sp } : null
}

function activeCreds(): RsCreds {
  const c = storedCreds()
  if (!c) throw rsError('RS.ge: სერვისის მომხმარებელი ან პაროლი არ არის მითითებული — მიმართე ადმინისტრატორს')
  return c
}

/** Seller IDs of the service user: from the last "check connection", or looked up now. */
async function seller(C: RsCreds) {
  let rs = db.get().rs
  if (!rs.sellerUnId) {
    const r = await live.check(C)
    db.set('rs', { ...db.get().rs, sellerUnId: r.unId, sellerUserId: r.userId, sellerTin: r.tin, sellerName: r.name, checkedAt: new Date().toISOString() })
    rs = db.get().rs
  }
  return { unId: rs.sellerUnId!, userId: rs.sellerUserId }
}

/** get_waybills_v1 accepts at most 3 days; a minute less to stay clear of the edge. */
const WINDOW_MS = 3 * 86400_000 - 60_000

export const rsge = {
  check: (c: RsCreds) => live.check(c),
  nameFromTin: (c: RsCreds, tin: string) => live.nameFromTin(c, tin),

  /** Creates the waybill on RS.ge (status: saved) and returns its ID. */
  async saveWaybill(p: RsWaybillPayload, shipmentId: string): Promise<number> {
    const c = activeCreds()
    return live.saveWaybill(c, await seller(c), p, shipmentId)
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

  /** Activates a saved waybill and returns its number. */
  sendWaybill: (waybillId: number, shipmentId: string) => live.sendWaybill(activeCreds(), waybillId, shipmentId),

  /** Completes the waybill (goods delivered). */
  closeWaybill: (waybillId: number, shipmentId: string) => live.finish('close_waybill', activeCreds(), waybillId, shipmentId),

  /** Cancels an activated or completed waybill. */
  cancelWaybill: (waybillId: number, shipmentId: string) => live.finish('ref_waybill', activeCreds(), waybillId, shipmentId),

  /** Deletes a saved draft (never activated). */
  deleteWaybill: (waybillId: number, shipmentId: string) => live.finish('del_waybill', activeCreds(), waybillId, shipmentId),

  /** The waybill as RS.ge has it now. `via` tags read-backs in the log; omitted when part of an upload. */
  getWaybill: (waybillId: number, shipmentId: string, via?: 'sync' | 'page') => live.getWaybill(activeCreds(), waybillId, shipmentId, via),

  /** The taxpayer's product list on RS.ge. */
  barCodes: () => live.barCodes(activeCreds()),
  /** One product on RS.ge by its exact bar code, or null when RS.ge doesn't have it. */
  async barCode(barCode: string): Promise<RsBarCode | null> {
    return (await live.barCodes(activeCreds(), barCode)).find((x) => x.barCode === barCode) ?? null
  },
  /** Adds or overwrites a product on RS.ge. Its answer can't be trusted on its own: check with barCode(). */
  saveBarCode: (p: RsBarCode) => live.saveBarCode(activeCreds(), p),
  /** Removes a product from RS.ge. */
  deleteBarCode: (barCode: string) => live.deleteBarCode(activeCreds(), barCode),

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

/** Forget cached error texts (after changing the service user). */
export function resetRsCache() {
  errorTexts = null
}

