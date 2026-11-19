import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { rsSettings } from '../api'

/** Georgian tax ID: 9 digits (company) or 11 (personal number). */
export const TIN_RE = /^\d{9}$|^\d{11}$/

/** `missing`: a foreign number RS.ge doesn't know — its name is typed by hand. */
export type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; name: string } | { state: 'missing' } | { state: 'error'; message: string }

/** Names already looked up in this session, so re-renders and remounts don't ask RS.ge again. */
const nameCache = new Map<string, string>()

/**
 * Looks the taxpayer's name up on RS.ge as soon as `tin` is complete: a full Georgian number, or
 * any foreign number. A stored name is never trusted: it may have been typed by hand.
 */
export function useTinName(tin: string, enabled: boolean, foreign = false): Lookup {
  const [res, setRes] = useState<{ key: string; lookup: Lookup }>({ key: '', lookup: { state: 'idle' } })
  const valid = enabled && (foreign ? tin !== '' : TIN_RE.test(tin))
  const key = `${foreign}:${tin}`
  const preset = nameCache.get(tin)
  useEffect(() => {
    if (!valid || preset) return
    let gone = false
    const t = setTimeout(() => {
      rsSettings.nameFromTin(tin, foreign).then(
        ({ name }) => {
          if (name) nameCache.set(tin, name)
          if (!gone) setRes({ key, lookup: name ? { state: 'ok', name } : { state: 'missing' } })
        },
        (e: Error) => !gone && setRes({ key, lookup: { state: 'error', message: e.message } }),
      )
    }, 300)
    return () => {
      gone = true
      clearTimeout(t)
    }
  }, [tin, foreign, key, valid, preset])
  if (!valid) return { state: 'idle' }
  if (preset) return { state: 'ok', name: preset }
  return res.key === key ? res.lookup : { state: 'loading' }
}

export function LookupLine({ lookup }: { lookup: Lookup }) {
  if (lookup.state === 'idle') return null
  return (
    <p className="mt-1 ml-1 flex items-center gap-1.5 text-xs">
      {lookup.state === 'loading' && (
        <>
          <Loader2 className="size-3.5 animate-spin text-slate-400" />
          <span className="text-slate-500">RS.ge-ზე მოწმდება…</span>
        </>
      )}
      {lookup.state === 'missing' && <span className="text-slate-500">RS.ge-ზე ვერ მოიძებნა — დასახელება შეიყვანე ხელით</span>}
      {lookup.state === 'ok' && (
        <>
          <CheckCircle2 className="size-3.5 text-emerald-500" />
          <span className="text-slate-900">{lookup.name}</span>
        </>
      )}
      {lookup.state === 'error' && (
        <>
          <XCircle className="size-3.5 text-rose-500" />
          <span className="text-rose-600">{lookup.message}</span>
        </>
      )}
    </p>
  )
}

