import { useSyncExternalStore } from 'react'
import { defaultRsSettings } from '../lib/rs'
import type { Database } from '../types'
import { api, getToken, onAuthLost } from './client'

/**
 * Client-side copy of the server's data. Pages read it synchronously through useDb();
 * it refreshes after every change this client makes and polls for changes made by
 * others (other users, other devices, the server's RS.ge/SMS pipeline).
 */
const EMPTY: Database = {
  version: 0,
  carriers: [],
  drivers: [],
  trucks: [],
  users: [],
  shipments: [],
  logs: [],
  settings: { latencyMs: 0, smsFailRate: 0 },
  cargo: { description: '', code: '', quantity: 0 },
  rs: defaultRsSettings(),
}

let state: Database = EMPTY
/** Opaque revision from the server; '' = nothing loaded yet. */
let rev = ''
let loaded = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

let inflight: Promise<void> | null = null

/** Fetches the latest data if anything changed on the server. */
export function refresh(): Promise<void> {
  if (!getToken()) return Promise.resolve()
  inflight ??= api<{ rev: string; db: Database } | undefined>('GET', `/api/state?rev=${encodeURIComponent(rev)}`)
    .then((r) => {
      if (r) {
        state = r.db
        rev = r.rev
      }
      if (r || !loaded) {
        loaded = true
        notify()
      }
    })
    .finally(() => (inflight = null))
  return inflight
}

export const db = {
  get: () => state,
  isLoaded: () => loaded,
  /** Optimistic local edit; the next refresh replaces it with the server's version. */
  patchLocal(fn: (d: Database) => Database) {
    state = fn(state)
    notify()
  },
  clear() {
    state = EMPTY
    rev = ''
    loaded = false
    notify()
  },
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

onAuthLost(() => db.clear())

const POLL_MS = 1500
setInterval(() => {
  if (document.visibilityState === 'visible') refresh().catch(() => {})
}, POLL_MS)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh().catch(() => {})
})

export function useDb(): Database {
  return useSyncExternalStore(db.subscribe, db.get)
}

export function useDbLoaded(): boolean {
  return useSyncExternalStore(db.subscribe, db.isLoaded)
}
