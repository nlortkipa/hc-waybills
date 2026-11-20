/**
 * App-facing API. Every change goes to the HC server (server/), which owns the data
 * and enforces the rules; reads come from the synced copy in ./store.
 */
import { useEffect } from 'react'
import { canUseCarrier } from '../lib/route'
import { active, shipmentUses } from '../lib/util'
import type { Carrier, Database, RsListWaybill, RsRemoteWaybill, Shipment, ShipmentItem, User } from '../types'
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

export type RefCollection = 'carriers' | 'routes' | 'drivers' | 'trucks' | 'products' | 'users'
type RefRecord<K extends RefCollection> = Database[K][number]

export const refs = {
  save<K extends RefCollection>(col: K, record: Omit<RefRecord<K>, 'id'> & { id?: string }) {
    return call<RefRecord<K>>('PUT', `/api/refs/${col}`, record)
  },

  /** Number of shipments that reference the record (they keep showing it after deletion). */
  shipmentCount(col: RefCollection, id: string): number {
    return db.get().shipments.filter((s) => shipmentUses(s, col, id)).length
  },

  /** Returns why a record cannot be deleted, or null if it can. The server checks the same rules. */
  blocker(col: RefCollection, id: string, _by?: User): string | null {
    if (col === 'users') {
      const admins = active(db.get().users).filter((u) => u.role === 'admin')
      if (admins.length === 1 && admins[0].id === id) return 'ეს ერთადერთი ადმინისტრატორია — ჯერ დანიშნე სხვა ადმინისტრატორი.'
    }
    if (col === 'carriers') {
      const u = refs.boundOperators(id)
      if (u) return `მიბმულია ${u} ოპერატორთან — ჯერ მოხსენი ეს კარიერი მათ ანგარიშებში.`
    }
    return null
  },

  /** Active operators given a carrier — they could no longer use it once it is deleted. */
  boundOperators(carrierId: string): number {
    return active(db.get().users).filter((x) => x.role === 'operator' && x.carrierIds?.includes(carrierId)).length
  },

  /** Deletes a record. If shipments reference it, the server soft-deletes it so reports keep showing it. */
  async remove(col: RefCollection, id: string, _by?: User) {
    await call('DELETE', `/api/refs/${col}/${encodeURIComponent(id)}`)
  },
}

/* ---------------------- Products and car numbers ---------------------- */

export const products = {
  /**
   * Reads the product list from RS.ge. Without `force` the server skips it when it read the list
   * moments ago (pages call this when they open); `force` is the admin's refresh button and reports errors.
   */
  sync(force = false) {
    return call('POST', '/api/products/sync', { force })
  },
  /** Deletes every product, here and on RS.ge. `failed`: codes RS.ge still lists afterwards. */
  clear() {
    return call<{ deleted: number; failed: number }>('POST', '/api/products/clear')
  },
}

export const trucks = {
  /** Reads the car-number list from RS.ge, like products.sync. */
  sync(force = false) {
    return call('POST', '/api/trucks/sync', { force })
  },
  /** Deletes every truck, here and on RS.ge. `failed`: plates RS.ge still lists afterwards. */
  clear() {
    return call<{ deleted: number; failed: number }>('POST', '/api/trucks/clear')
  },
  /** Puts the plates of trucks stored here but missing from RS.ge's list onto it. */
  pushPlates() {
    return call<{ added: number }>('POST', '/api/trucks/push')
  },
}

/* --------------------- Waybills of listed shipments --------------------- */

/** When each shipment's waybill was last asked for, so a page doesn't ask again on every poll. */
const askedAt = new Map<string, number>()
const ASK_AGAIN_MS = 60_000

/**
 * A shipment's waybill details (goods, quantity, state, invoice) are RS.ge's and the server reads them
 * from RS.ge only when something shows them. Pages listing shipments call this with what they list;
 * the ones whose waybill isn't read yet are asked for, and arrive with the next state poll.
 */
export function useRsLoad(list: Shipment[]) {
  useEffect(() => {
    const now = Date.now()
    const ids = list.filter((s) => s.rsWaybillId && !s.rsRemote && now - (askedAt.get(s.id) ?? 0) > ASK_AGAIN_MS).map((s) => s.id)
    if (!ids.length) return
    for (const id of ids) askedAt.set(id, now)
    void api('POST', '/api/shipments/rs-load', { ids }).catch(() => {})
  }, [list])
}

/** Whether a shipment's waybill details are still to come from RS.ge (asked for, not read yet). */
export const rsPending = (s: Shipment) => !!s.rsWaybillId && !s.rsRemote

/* ------------------------------ RS.ge ------------------------------ */

export const rsSettings = {
  /** Checks a service user on RS.ge and stores it only if it works. Empty `sp` re-checks the stored password. */
  connect(creds: { su: string; sp?: string }) {
    return call<{ tin: string; name: string }>('POST', '/api/rs/connection', creds)
  },
  /** Forgets the stored service user. */
  disconnect() {
    return call('DELETE', '/api/rs/connection')
  },
  /** Reads the changes made on RS.ge now instead of waiting for the background sync. */
  syncNow() {
    return call('POST', '/api/rs/sync')
  },
}

/* ------------------------------ SMS ------------------------------ */

export const smsSettings = {
  /** Checks the smsoffice.ge key and stores it with the sender. Empty `apiKey` keeps the stored key. Admin only. */
  save(value: { apiKey?: string; sender: string }) {
    return call<{ balance: number }>('PUT', '/api/sms', value)
  },
  /** Forgets the smsoffice.ge account. */
  disconnect() {
    return call('DELETE', '/api/sms')
  },
  /** Sends a test SMS to the number with the stored account. */
  test(phone: string) {
    return call('POST', '/api/sms/test', { phone })
  },
}

/* ---------------------------- Shipments ---------------------------- */

/** Carriers a user can create shipments for: an operator's own, everyone else's all. Deleted ones are left out. */
export function usableCarriers(d: Database, user: User): Carrier[] {
  return active(d.carriers).filter((c) => canUseCarrier(user, c.id))
}

/** Carriers whose shipments the user sees, deleted ones included (their shipments stay visible). */
export function userCarriers(d: Database, user: User): Carrier[] {
  return user.role === 'operator' ? d.carriers.filter((c) => canUseCarrier(user, c.id)) : d.carriers
}

export function visibleShipments(d: Database, user: User): Shipment[] {
  const list = d.shipments.filter((s) => canUseCarrier(user, s.carrierId))
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** A goods line of a route, as the admin wrote it. */
export type NewRouteGood = Omit<ShipmentItem, 'aTitle'>

/** What an operator picks for a shipment: the goods and the waybill's options come from the route. */
export interface NewShipmentInput {
  routeId: string
  driverId: string
  truckId: string
  /** Save on RS.ge without activating. */
  draft?: boolean
}

export const shipments = {
  /** Creates the record; the server uploads it to RS.ge and texts the driver in the background. */
  async create(input: NewShipmentInput, _user: User): Promise<string> {
    const { id } = await call<{ id: string }>('POST', '/api/shipments', input)
    return id
  },

  /** Changes a shipment: on RS.ge a draft is overwritten and an active waybill corrected. */
  async edit(id: string, input: NewShipmentInput) {
    await call('PUT', `/api/shipments/${encodeURIComponent(id)}`, input)
  },

  /** Activates a draft: now, or from `beginAt` (up to 3 days ahead). */
  async activate(id: string, beginAt?: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/activate`, { beginAt })
  },

  /** Writes a tax invoice from the waybill on RS.ge. */
  async invoice(id: string) {
    return call<{ invoiceId: number }>('POST', `/api/shipments/${encodeURIComponent(id)}/invoice`)
  },

  /** Retries the pipeline (RS.ge → SMS) on the server. */
  async run(id: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/run`)
  },

  async retrySms(id: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/retry-sms`)
  },

  /** Completes (goods delivered, now or on `deliveredAt`), cancels, or deletes (a draft) the shipment's waybill on RS.ge. */
  async finish(id: string, action: 'close' | 'cancel' | 'delete', deliveredAt?: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/${action}`, { deliveredAt })
  },

  /** Re-reads the shipment's waybill from RS.ge (status, corrections made on the rs.ge portal). */
  async refreshFromRs(id: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/rs-refresh`)
  },

  /** Asks smsoffice.ge whether the driver got the SMS. */
  async refreshSms(id: string) {
    await call('POST', `/api/shipments/${encodeURIComponent(id)}/sms-refresh`)
  },

  isRunning: (id: string) => {
    const s = db.get().shipments.find((x) => x.id === id)
    return !!s && (s.status === 'uploading' || s.sms.status === 'running')
  },
}

/* ------------------------- RS.ge registry ------------------------- */

export type RsWaybillAction = 'close' | 'cancel' | 'delete' | 'activate' | 'invoice' | 'confirm' | 'reject'
export type RsWaybillDetail = RsRemoteWaybill & { shipmentId?: string }

export const rsWaybills = {
  /** The taxpayer's issued or received waybills created in the period, as RS.ge lists them. */
  list(side: 'issued' | 'received', from: string, to: string) {
    return api<RsListWaybill[]>('GET', `/api/rs/waybills?side=${side}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  },
  /** One waybill as RS.ge has it now. */
  get(id: number) {
    return api<RsWaybillDetail>('GET', `/api/rs/waybills/${id}`)
  },
  /** An action as on the portal; returns the waybill after it. */
  act(id: number, action: RsWaybillAction, body?: { beginAt?: string; deliveredAt?: string }) {
    return call<RsWaybillDetail>('POST', `/api/rs/waybills/${id}/${action}`, body)
  },
}

/* ------------------------------ Logs ------------------------------ */

export const logs = {
  async clear() {
    await call('DELETE', '/api/logs')
  },
}
