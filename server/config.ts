/**
 * The external services' accounts, from .env (see .env.example). Nothing here is stored in the
 * database or editable in the app: change .env and restart.
 *
 *   RS_SERVICE_USER, RS_SERVICE_PASSWORD   RS.ge service user ("name:taxcode") and its password
 *   SMSOFFICE_API_KEY, SMSOFFICE_SENDER    smsoffice.ge API key and the sender name registered there
 *   RS_WAYBILL_URL, SMSOFFICE_URL          optional: other endpoints (default: the live services)
 *   WAYBILL_AUTO_CLOSE                     optional "H:MM": an active waybill is completed this long
 *                                          after transport starts (0:00 = at once, empty = never)
 *   LOGIN_CODES                            optional "sms" (default) or "console": login codes are
 *                                          printed in the server console instead of texted (testing)
 *   SCALE_CALLBACK_USER, …_PASSWORD,       what the scale signs the real weight with when it posts it to
 *   SCALE_CALLBACK_SECRET                  /api/scale/weight (its SAP:API:Auth:User/Pass and SAP:API:Secret)
 *   SCALE_TRUCK_CODE                       optional: the scale's transport code for our trucks (T00002)
 *
 * The server refuses to start unless every one is set and both services accept them (server/index.ts).
 */
import './env.ts'

const env = (name: string) => process.env[name]?.trim() ?? ''

export const RS_SU = env('RS_SERVICE_USER')
export const RS_SP = process.env.RS_SERVICE_PASSWORD ?? ''
export const SMS_API_KEY = env('SMSOFFICE_API_KEY')
export const SMS_SENDER = env('SMSOFFICE_SENDER')

/** WAYBILL_AUTO_CLOSE as written: hours, a colon and two-digit minutes. */
const AUTO_CLOSE_RE = /^(\d{1,4}):([0-5]\d)$/
const AUTO_CLOSE = env('WAYBILL_AUTO_CLOSE')
const autoClose = AUTO_CLOSE_RE.exec(AUTO_CLOSE)
/** How long after transport starts an active waybill is completed on its own (ms): 0 = at once, null = never. */
export const AUTO_CLOSE_MS = autoClose ? (Number(autoClose[1]) * 60 + Number(autoClose[2])) * 60_000 : null

/** Where login codes go: texted to the user (default) or printed in the server console, for testing. */
const LOGIN_CODES = env('LOGIN_CODES').toLowerCase() || 'sms'
export const LOGIN_CODES_TO_CONSOLE = LOGIN_CODES === 'console'

/** Basic-auth user and password and the signing secret the scale posts real weights with ('' = not accepted). */
export const SCALE_CALLBACK_USER = env('SCALE_CALLBACK_USER')
export const SCALE_CALLBACK_PASSWORD = process.env.SCALE_CALLBACK_PASSWORD ?? ''
export const SCALE_CALLBACK_SECRET = process.env.SCALE_CALLBACK_SECRET ?? ''
/** The scale's transport code for a truck outside its logistics fleet (its SAP:StaticData:CarCode). */
export const SCALE_TRUCK_CODE = env('SCALE_TRUCK_CODE') || 'T00002'

/** Sender names smsoffice.ge accepts: up to 11 Latin letters, digits, '-', '.' (words may be separated by spaces). */
export const SENDER_RE = /^[A-Za-z0-9.\- ]{1,11}$/

/** What is missing or malformed in .env, one line each. Empty = complete. */
export function configProblems(): string[] {
  const out: string[] = []
  if (!RS_SU) out.push('RS_SERVICE_USER is not set')
  else if (!/^[^:]+:(\d{9}|\d{11})$/.test(RS_SU)) out.push('RS_SERVICE_USER must look like name:taxcode (taxcode: 9 or 11 digits)')
  if (!RS_SP) out.push('RS_SERVICE_PASSWORD is not set')
  if (!SMS_API_KEY) out.push('SMSOFFICE_API_KEY is not set')
  if (!SMS_SENDER) out.push('SMSOFFICE_SENDER is not set')
  else if (!SENDER_RE.test(SMS_SENDER)) out.push('SMSOFFICE_SENDER: at most 11 Latin letters, digits, "-" or "."')
  if (LOGIN_CODES !== 'sms' && LOGIN_CODES !== 'console') out.push('LOGIN_CODES must be "sms" or "console", or be empty')
  if (AUTO_CLOSE && !autoClose) out.push('WAYBILL_AUTO_CLOSE must look like H:MM (e.g. 8:30), or be empty')
  const callback = [SCALE_CALLBACK_USER, SCALE_CALLBACK_PASSWORD, SCALE_CALLBACK_SECRET].filter(Boolean).length
  if (callback && callback < 3) out.push('SCALE_CALLBACK_USER, SCALE_CALLBACK_PASSWORD and SCALE_CALLBACK_SECRET are set together, or none of them')
  return out
}
