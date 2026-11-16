/**
 * App-facing API. Every change goes to the HC server (server/), which owns the data
 * and enforces the rules; reads come from the synced copy in ./store.
 */
import { active } from '../lib/util'
import type { CargoDefaults, Database, MockSettings, RsSettings, Shipment, User } from '../types'
import { api, getToken, setToken } from './client'
import { db, refresh } from './store'

/** Runs a server call, then pulls the resulting state so the UI updates right away. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const out = await api<T>(method, path, body)
  await refresh().catch(() => {})
  return out
}

/* ------------------------------ Auth ------------------------------ */

export const auth = {
  /** The logged-in user according to the server, or null. */
  async current(): Promise<User | null> {
    if (!getToken()) return null
    try {
      return await api<User>('GET', '/api/me')
    } catch {
      return null
    }
  },
  /** Logs in by phone number. Later the server will send an SMS code first. */
  async loginByPhone(phone: string): Promise<User> {
    const { token, user } = await api<{ token: string; user: User }>('POST', '/api/login', { phone })
    setToken(token)
    await refresh()
    return user
  },
  async logout() {
    await api('POST', '/api/logout').catch(() => {})
    setToken(null)
    db.clear()
  },
}

/* ------------------------- Reference data ------------------------- */

export type RefCollection = 'carriers' | 'drivers' | 'trucks' | 'users'
type RefRecord<K extends RefCollection> = Database[K][number]

export const refs = {
  save<K extends RefCollection>(col: K, record: Omit<RefRecord<K>, 'id'> & { id?: string }) {
    return call<RefRecord<K>>('PUT', `/api/refs/${col}`, record)
  },

  /** Number of shipments that reference the record (they keep showing it after deletion). */
  shipmentCount(col: RefCollection, id: string): number {
    const k = ({ carriers: 'carrierId', drivers: 'driverId', trucks: 'truckId', users: 'createdBy' } as const)[col]
    return db.get().shipments.filter((s) => s[k] === id).length
  },

  /** Returns why a record cannot be deleted, or null if it can. The server checks the same rules. */
  blocker(col: RefCollection, id: string, by?: User): string | null {
    if (col === 'users' && by?.id === id) return 'საკუთარი ანგარიშის წაშლა შეუძლებელია.'
    if (col === 'carriers') {
      const u = refs.boundOperators(id)
      if (u) return `მიბმულია ${u} ოპერატორთან — ჯერ შეცვალე ან წაშალე ისინი.`
    }
    return null
  },

  /** Active operators bound to a carrier — they can no longer create shipments once it is deleted. */
  boundOperators(carrierId: string): number {
    return active(db.get().users).filter((x) => x.role === 'operator' && x.carrierId === carrierId).length
  },

  /** Deletes a record. If shipments reference it, the server soft-deletes it so reports keep showing it. */
  async remove(col: RefCollection, id: string, _by?: User) {
    await call('DELETE', `/api/refs/${col}/${encodeURIComponent(id)}`)
  },
}

/* ------------------------------ Cargo ------------------------------ */

export const cargo = {
  /** Sets the cargo and declared quantity used for every new shipment. Admin only. */
  async save(value: CargoDefaults, _user?: User) {
    await call('PUT', '/api/cargo', value)
  },
}

/* ------------------------------ RS.ge ------------------------------ */

export const rsSettings = {
  /** Saves the RS.ge settings. Leave `sp` empty to keep the stored password. Admin only. */
  async save(value: Partial<RsSettings>) {
    await call('PUT', '/api/rs', value)
  },
  /** Tests a service user on RS.ge (typed values, or the stored ones when empty). */
  check(creds: { su?: string; sp?: string }) {
    return call<{ tin: string; name: string; unId: number; saved: boolean }>('POST', '/api/rs/check', creds)
  },
  /** Taxpayer name for a tax ID / personal number, from RS.ge. */
  nameFromTin(tin: string, creds: { su?: string; sp?: string }) {
    return api<{ name: string }>('POST', '/api/rs/name', { tin, ...creds })
  },
}

/* ---------------------------- Shipments ---------------------------- */

export function visibleShipments(d: Database, user: User): Shipment[] {
  const list = user.role === 'operator' ? d.shipments.filter((s) => s.carrierId === user.carrierId) : d.shipments
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export interface NewShipmentInput {
  carrierId: string
  destinationId: string
  driverId: string
  truckId: string
}

export const shipments = {
  /** Creates the record; the server uploads it to RS.ge and texts the driver in the background. */
  async create(input: NewShipmentInput, _user: User): Promise<string> {
    const { id } = await call<{ id: string }>('POST', '/api/shipments', input)
    return id
  },

  /** Retries the pipeline (RS.ge → SMS) on the server. */
  async run(id: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/run`)
  },

  async retrySms(id: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/retry-sms`)
  },

  /** Completes (goods delivered) or cancels the shipment's waybill on RS.ge. */
  async finish(id: string, action: 'close' | 'cancel') {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/${action}`)
  },

  isRunning: (id: string) => {
    const s = db.get().shipments.find((x) => x.id === id)
    return !!s && (s.status === 'uploading' || s.sms.status === 'running')
  },
}

/* ------------------------------ Mock ------------------------------ */

let settingsTimer: ReturnType<typeof setTimeout> | undefined
let pendingSettings: Partial<MockSettings> = {}

export const mock = {
  /** Applied locally at once (sliders), sent to the server once dragging pauses. */
  updateSettings(p: Partial<MockSettings>) {
    db.patchLocal((d) => ({ ...d, settings: { ...d.settings, ...p } }))
    pendingSettings = { ...pendingSettings, ...p }
    clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => {
      const body = pendingSettings
      pendingSettings = {}
      void call('PATCH', '/api/mock/settings', body).catch(() => {})
    }, 300)
  },
  async clearLogs() {
    await call('DELETE', '/api/mock/logs')
  },
  async reset() {
    await call('POST', '/api/mock/reset')
  },
}
