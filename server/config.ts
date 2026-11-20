/**
 * The external services' accounts, from .env (see .env.example). Nothing here is stored in the
 * database or editable in the app: change .env and restart.
 *
 *   RS_SERVICE_USER, RS_SERVICE_PASSWORD   RS.ge service user ("name:taxcode") and its password
 *   SMSOFFICE_API_KEY, SMSOFFICE_SENDER    smsoffice.ge API key and the sender name registered there
 *   RS_WAYBILL_URL, SMSOFFICE_URL          optional: other endpoints (default: the live services)
 *
 * The server refuses to start unless every one is set and both services accept them (server/index.ts).
 */
import './env.ts'

const env = (name: string) => process.env[name]?.trim() ?? ''

export const RS_SU = env('RS_SERVICE_USER')
export const RS_SP = process.env.RS_SERVICE_PASSWORD ?? ''
export const SMS_API_KEY = env('SMSOFFICE_API_KEY')
export const SMS_SENDER = env('SMSOFFICE_SENDER')

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
  return out
}
