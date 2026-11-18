/**
 * SMS through smsoffice.ge (docs: https://smsoffice.ge/integration). No dependencies.
 *
 *   POST /api/v2/send/              key, destination, sender, content, reference → { Success, Message, Output, ErrorCode }
 *   POST /api/v2/getMessageStatus/  key, destination, reference → Output.Status (Delivered, Undelivered, Expired, Pending, Unknown)
 *   POST /api/getBalance/           key → the number of messages left, as plain text
 *
 * Every call sends the key in a form body, never in the URL, and the trailing slashes are required
 * (without one the server answers with a redirect). ErrorCode 0 on send only means "accepted":
 * whether the phone got it is known later from getMessageStatus. getBalance has no error format: a
 * wrong key gets a .NET stack trace, so any answer that is not a number means the key was refused.
 *
 * The API key and sender are entered by the admin and stored on the server (the key encrypted, see
 * server/secret.ts). Every call goes to the integration log with the key masked.
 */
import { randomBytes } from 'node:crypto'
import type { IntegrationLog, SmsDelivery } from '../src/types.ts'
import { IntegrationError, log } from './integrations.ts'

const BASE = (process.env.SMSOFFICE_URL ?? 'https://smsoffice.ge').replace(/\/+$/, '')
const TIMEOUT_MS = 20_000

export interface SmsCreds {
  apiKey: string
  sender: string
}

/** The send / status answer. */
interface Reply {
  Success: boolean
  Message: string | null
  Output: unknown
  ErrorCode: number
}

/** Georgian explanations of smsoffice.ge's error codes (from their documentation). */
const ERRORS: Record<number, string> = {
  10: 'ნომრებს შორის არის არაქართული ნომერი',
  20: 'smsoffice.ge-ზე ბალანსი არასაკმარისია — შეავსე ბალანსი',
  40: 'ტექსტი 160 სიმბოლოზე გრძელია',
  60: 'ტექსტი ცარიელია',
  70: 'ნომერი არ არის მითითებული',
  75: 'ნომერი smsoffice.ge-ს შავ სიაშია (მიმღებმა შეტყობინებები დაბლოკა)',
  76: 'ნომრის ფორმატი არასწორია',
  77: 'ნომერი შავ სიაშია ან მისი ფორმატი არასწორია',
  80: 'smsoffice.ge-ს API გასაღები არასწორია',
  110: 'გამგზავნის სახელი ვერ იქნა გაგებული',
  120: 'smsoffice.ge-ზე API ჩართული არ არის — ჩართე პროფილის გვერდზე',
  150: 'გამგზავნის სახელი smsoffice.ge-ზე ვერ მოიძებნა — შეამოწმე მართლწერა ან დაარეგისტრირე',
  500: 'API გასაღები არ არის მითითებული',
  600: 'ნომერი არ არის მითითებული',
  700: 'გამგზავნის სახელი არ არის მითითებული',
  800: 'ტექსტი არ არის მითითებული',
  [-100]: 'smsoffice.ge დროებით ვერ ამუშავებს მოთხოვნას — სცადე ცოტა ხანში',
}

/** Codes after which nothing was sent and sending again later can work (as opposed to "fix the settings"). */
const TEMPORARY = new Set([-100])

const smsError = (message: string, rejected = false) => new IntegrationError('SMS', message, rejected)

/** Sender names smsoffice.ge accepts: up to 11 Latin letters, digits, '-', '.' (words may be separated by spaces). */
export const SENDER_RE = /^[A-Za-z0-9.\- ]{1,11}$/

/** A Georgian mobile number (any common spelling) as smsoffice.ge wants it: 9955XXXXXXXX. null if it isn't one. */
export function toDestination(phone: string): string | null {
  const local = phone.replace(/\D/g, '').replace(/^(00)?995(?=\d{9}$)/, '')
  return /^5\d{8}$/.test(local) ? `995${local}` : null
}

/** Message label for delivery reports: at most 20 characters, unique per send. */
export const newReference = () => randomBytes(8).toString('hex')

/**
 * POSTs a form to smsoffice.ge and logs the exchange, key masked. Returns the HTTP status and body;
 * throws when no answer arrived (then whether a message went out is unknown).
 */
async function post(path: string, form: Record<string, string>, ctx: { shipmentId?: string; readBack?: IntegrationLog['readBack']; accepted: (http: number, raw: string) => boolean }) {
  const logged = { ...form, key: '••••••' }
  const endpoint = `POST smsoffice.ge${path}`
  const started = Date.now()
  let http = 0
  let raw = ''
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
    http = res.status
    raw = await res.text()
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError'
    const message = timeout ? 'smsoffice.ge-მ დროულად არ უპასუხა (timeout)' : `smsoffice.ge მიუწვდომელია: ${(e as Error).message}`
    log({ service: 'SMS', direction: 'out', endpoint, request: logged, response: { error: message }, ok: false, durationMs: Date.now() - started, shipmentId: ctx.shipmentId, readBack: ctx.readBack })
    throw smsError(message)
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // Plain text (getBalance) or an error page; a refused key gets a whole .NET stack trace, so keep its first line.
    const first = raw.trim().split('\n')[0].trim()
    body = first.length > 300 ? first.slice(0, 300) + '…' : first + (raw.trim().includes('\n') ? ' …' : '')
  }
  log({ service: 'SMS', direction: 'out', endpoint, request: logged, response: { http, body }, ok: ctx.accepted(http, raw), durationMs: Date.now() - started, shipmentId: ctx.shipmentId, readBack: ctx.readBack })
  return { http, raw }
}

/** Parses a send/status answer. Throws a Georgian error for anything but ErrorCode 0. */
function parseReply(http: number, raw: string): Reply {
  let r: Reply
  try {
    r = JSON.parse(raw) as Reply
  } catch {
    throw smsError(`smsoffice.ge-მ დააბრუნა მოულოდნელი პასუხი (HTTP ${http})`)
  }
  if (typeof r?.ErrorCode !== 'number') throw smsError(`smsoffice.ge-მ დააბრუნა მოულოდნელი პასუხი (HTTP ${http})`)
  if (r.ErrorCode !== 0 || !r.Success) {
    const text = ERRORS[r.ErrorCode] ?? r.Message ?? 'უცნობი შეცდომა'
    // An answer with an error code means nothing was sent.
    throw smsError(`SMS: ${text} (კოდი ${r.ErrorCode})`, !TEMPORARY.has(r.ErrorCode))
  }
  return r
}

const isOkReply = (http: number, raw: string) => http === 200 && /"ErrorCode"\s*:\s*0\b/.test(raw)

export const smsoffice = {
  /**
   * Sends one SMS to a number from toDestination(). Resolves once smsoffice.ge accepted it (not yet
   * delivered). `reference` (newReference()) labels it for status() later.
   */
  async send(c: SmsCreds, destination: string, text: string, reference: string, shipmentId?: string): Promise<void> {
    const { http, raw } = await post('/api/v2/send/', { key: c.apiKey, destination, sender: c.sender, content: text, reference }, { shipmentId, accepted: isOkReply })
    parseReply(http, raw)
  },

  /** How the message stands now: Pending until the operator reports back. */
  async status(c: Pick<SmsCreds, 'apiKey'>, destination: string, reference: string, shipmentId?: string): Promise<SmsDelivery> {
    const { http, raw } = await post('/api/v2/getMessageStatus/', { key: c.apiKey, destination, reference }, { shipmentId, readBack: 'page', accepted: isOkReply })
    const out = parseReply(http, raw).Output as { Status?: string } | null
    const s = String(out?.Status ?? '').toLowerCase()
    return (['Delivered', 'Undelivered', 'Expired', 'Pending'] as const).find((x) => x.toLowerCase() === s) ?? 'Unknown'
  },

  /** Messages left on the account. Doubles as the key check: a refused key gets no number. */
  async balance(c: Pick<SmsCreds, 'apiKey'>): Promise<number> {
    const isNumber = (raw: string) => /^-?\d+(\.\d+)?$/.test(raw.trim().replace(/^"|"$/g, ''))
    const { http, raw } = await post('/api/getBalance/', { key: c.apiKey }, { accepted: (h, r) => h === 200 && isNumber(r) })
    if (http === 200 && isNumber(raw)) return Number(raw.trim().replace(/^"|"$/g, ''))
    if (http >= 500 || http === 0) throw smsError(`smsoffice.ge-მ დააბრუნა შეცდომა (HTTP ${http})`)
    throw smsError(ERRORS[80], true)
  },
}
