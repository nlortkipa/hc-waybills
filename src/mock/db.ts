import { useSyncExternalStore } from 'react'
import type { Database } from '../types'
import { createSeed, DB_VERSION } from './seed'

/**
 * Tiny in-browser "database" persisted to localStorage.
 * Stands in for the real backend until the API exists.
 */
const KEY = 'hc.mockdb'

function load(): Database {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Database
      if (parsed.version === DB_VERSION) return parsed
    }
  } catch {
    /* corrupted or unavailable storage — fall back to seed */
  }
  return createSeed()
}

let state: Database = load()
const listeners = new Set<() => void>()

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage full / unavailable — keep in memory */
  }
}

export const db = {
  get: () => state,
  update(fn: (d: Database) => Database) {
    state = fn(state)
    persist()
    listeners.forEach((l) => l())
  },
  reset() {
    state = createSeed()
    persist()
    listeners.forEach((l) => l())
  },
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

// Keep multiple open tabs in sync.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) {
    state = load()
    listeners.forEach((l) => l())
  }
})

export function useDb(): Database {
  return useSyncExternalStore(db.subscribe, db.get)
}
