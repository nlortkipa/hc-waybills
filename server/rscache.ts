/**
 * RS.ge's data, read from RS.ge on demand and kept in memory only, never in the database:
 *
 * - the product list (get_bar_codes) and the car-number list (get_car_numbers), read again when older
 *   than LIST_TTL_MS while someone uses the app, and at once after a change made here;
 * - waybills (get_waybill), read when a page shows them (`want`) or when a shipment is opened or
 *   changed (`read`). While anyone uses the app, RS.ge is asked every CHANGES_TTL_MS which waybills
 *   changed (get_waybills_v1), and the ones held here are read again, so a change made on the rs.ge
 *   portal shows up. Drafts are read again too, so one activated on the portal gets its SMS.
 *
 * "While someone uses the app" = clients polling the state (`touch`): with nobody looking, RS.ge isn't
 * called. Everything here is per service user: another one (or none) starts over. `gen` changes with
 * every change here, so it is part of the state revision clients poll with.
 */
import type { Product, RsRemoteWaybill } from '../src/types.ts'
import { RS_SU } from './config.ts'
import { onAccountChange, rsge, storedCreds, type RsBarCode } from './rsge.ts'
import { store as db } from './store.ts'

const SECONDS = (name: string, fallback: number) => Math.max(5, Number(process.env[name] ?? fallback) || fallback) * 1000

/** Lists (products, car numbers) are read again after this long. */
const LIST_TTL_MS = SECONDS('RS_LIST_SECONDS', 300)
/** RS.ge is asked which waybills changed at most this often. */
const CHANGES_TTL_MS = SECONDS('RS_CHANGES_SECONDS', 60)
/** A failed read is not retried sooner than this. */
const RETRY_MS = 30_000
/** get_waybills_v1 reads at most 3 days back: after a longer pause the waybills held here are read again. */
const CHANGES_MAX_BACK_MS = 3 * 86400_000 - 60 * 60_000
/** Each check re-reads this much of the previous window, against clock differences between the servers. */
const CHANGES_OVERLAP_MS = 5 * 60_000
/** Waybills read at the same time. */
const PARALLEL = 3
/** Waybills held at most; the ones read longest ago go first. */
const MAX_WAYBILLS = 5000

let gen = 0
const bump = () => void gen++
// The account info (read, failed or forgotten) is part of every view.
onAccountChange(bump)

interface ListState<T> {
  value: T[] | null
  /** When it was last read successfully. */
  at?: string
  error?: string
  /** Last attempt (ms), successful or not. */
  tried: number
  loading: Promise<T[]> | null
}
const emptyList = <T,>(): ListState<T> => ({ value: null, tried: 0, loading: null })

let products = emptyList<RsBarCode>()
let plates = emptyList<string>()

const waybills = new Map<number, RsRemoteWaybill>()
const reading = new Map<number, Promise<RsRemoteWaybill>>()
const failedAt = new Map<number, number>()
/** Waybill IDs to read in the background, and the ones among them to read even though one is held. */
const queue: number[] = []
const stale = new Set<number>()
let active = 0

let changes: { to: number; error?: string; tried: number; loading: Promise<void> | null } = { to: 0, tried: 0, loading: null }
let accountTried = 0

/** Called with each waybill read for a shipment, and what was held before. */
let onWaybill: (shipmentId: string, prev: RsRemoteWaybill | undefined, next: RsRemoteWaybill) => void = () => {}

/** The service user everything here belongs to. */
let owner = ''
function sameOwner() {
  const su = RS_SU
  if (su !== owner) {
    // Another service user: what was read belongs to the previous one.
    owner = su
    rsCache.reset()
  }
  return !!storedCreds()
}

const shipmentOf = (waybillId: number) => db.get().shipments.find((s) => s.rsWaybillId === waybillId)?.id

function hold(id: number, w: RsRemoteWaybill) {
  waybills.delete(id)
  waybills.set(id, w)
  if (waybills.size > MAX_WAYBILLS) waybills.delete(waybills.keys().next().value!)
  failedAt.delete(id)
  bump()
}

async function readList<T>(get: () => ListState<T>, set: (s: ListState<T>) => void, load: () => Promise<T[]>): Promise<T[]> {
  const cur = get()
  if (cur.loading) return cur.loading
  const su = owner
  const p = load().then(
    (value) => {
      if (owner === su) set({ value, at: new Date().toISOString(), tried: Date.now(), loading: null })
      bump()
      return value
    },
    (e: Error) => {
      if (owner === su) set({ ...get(), error: e.message, tried: Date.now(), loading: null })
      bump()
      throw e
    },
  )
  set({ ...cur, tried: Date.now(), loading: p })
  return p
}

function pump() {
  while (active < PARALLEL && queue.length) {
    const id = queue.shift()!
    const force = stale.delete(id)
    if ((!force && waybills.has(id)) || reading.has(id)) continue
    if (!force && Date.now() - (failedAt.get(id) ?? 0) < RETRY_MS) continue
    active++
    void rsCache
      .read(id, shipmentOf(id), 'sync')
      .catch(() => {})
      .finally(() => {
        active--
        pump()
      })
  }
}

function enqueue(ids: Iterable<number>, force = false) {
  for (const id of ids) {
    if (force) stale.add(id)
    if (!queue.includes(id)) queue.push(id)
  }
  pump()
}

/** Drafts on RS.ge: re-read so one activated on the portal is noticed. */
const draftIds = () => db.get().shipments.filter((s) => s.status === 'saved' && s.rsWaybillId).map((s) => s.rsWaybillId!)

async function checkChanges() {
  const now = Date.now()
  if (!changes.to || now - changes.to > CHANGES_MAX_BACK_MS) {
    // Nothing older can be asked about: what is held is read again when it is next shown.
    if (waybills.size) {
      waybills.clear()
      bump()
    }
    changes = { ...changes, to: now, error: undefined }
    enqueue(draftIds(), true)
    return
  }
  const su = owner
  const list = await rsge.changed(new Date(changes.to - CHANGES_OVERLAP_MS), new Date(now))
  if (owner !== su) return
  const drafts = new Set(draftIds())
  enqueue(
    list.map((w) => w.id).filter((id) => waybills.has(id) || drafts.has(id)),
    true,
  )
  changes = { ...changes, to: now, error: undefined }
  bump()
}

export const rsCache = {
  gen: () => gen,

  /** Forgets everything (another service user, or none). */
  reset() {
    products = emptyList()
    plates = emptyList()
    waybills.clear()
    reading.clear()
    failedAt.clear()
    queue.length = 0
    stale.clear()
    changes = { to: 0, tried: 0, loading: null }
    accountTried = 0
    bump()
  },

  /** A client polled the state: read again whatever is due. Never waits, never throws. */
  touch() {
    if (!sameOwner()) return
    const now = Date.now()
    const account = rsge.account()
    if (!account && now - accountTried > RETRY_MS) {
      accountTried = now
      void rsge.loadAccount().catch(() => bump())
    } else if (account && !account.akciz.length && now - accountTried > LIST_TTL_MS) {
      accountTried = now
      void rsge.reloadAkciz().catch(() => {})
    }
    const due = (s: ListState<unknown>) => !s.loading && now - s.tried > (s.error ? RETRY_MS : LIST_TTL_MS)
    if (due(products)) void rsCache.loadProducts().catch(() => {})
    if (due(plates)) void rsCache.loadPlates().catch(() => {})
    if (!changes.loading && now - changes.tried > (changes.error ? RETRY_MS : CHANGES_TTL_MS)) void rsCache.checkChanges().catch(() => {})
  },

  /* -------------------------------- Products -------------------------------- */

  /** RS.ge's product list as products (id = bar code); [] until it has been read. */
  products(): Product[] {
    // RS.ge leaves the unit's name out for its own units: it comes from the units list.
    const units = rsge.account()?.units ?? []
    const prices = db.productPrices.all()
    return (products.value ?? []).map((p) => ({
      id: p.barCode,
      name: p.name || p.barCode,
      barCode: p.barCode,
      unitId: p.unitId,
      unitTxt: p.unitTxt || units.find((u) => u.id === p.unitId)?.name || '',
      aId: p.aId,
      ...prices.get(p.barCode.toLowerCase()),
    }))
  },
  productsStatus: () => ({ at: products.at, error: products.error }),
  /** Reads the product list now (joins a read in progress). */
  loadProducts(): Promise<RsBarCode[]> {
    if (!sameOwner()) return Promise.resolve([])
    return readList(
      () => products,
      (s) => (products = s),
      () => rsge.barCodes(),
    )
  },

  /* ------------------------------ Car numbers ------------------------------ */

  /** RS.ge's car numbers, or null while they haven't been read. */
  plates: (): string[] | null => plates.value,
  platesStatus: () => ({ at: plates.at, error: plates.error }),
  loadPlates(): Promise<string[]> {
    if (!sameOwner()) return Promise.resolve([])
    return readList(
      () => plates,
      (s) => (plates = s),
      () => rsge.carNumbers(),
    )
  },

  /* -------------------------------- Waybills -------------------------------- */

  waybill: (id: number): RsRemoteWaybill | undefined => waybills.get(id),

  /** Reads the waybill now and holds it. `shipmentId` ties the log entry (and the change check) to the shipment. */
  read(id: number, shipmentId: string | undefined, via?: 'sync' | 'page'): Promise<RsRemoteWaybill> {
    sameOwner()
    const running = reading.get(id)
    if (running) return running
    const su = owner
    const p = rsge
      .getWaybill(id, shipmentId, via)
      .then((w) => {
        if (owner !== su) return w
        const prev = waybills.get(id)
        hold(id, w)
        try {
          if (shipmentId) onWaybill(shipmentId, prev, w)
        } catch (e) {
          // The read itself succeeded: a failure recording our side doesn't make it fail.
          console.error('[rs-cache] recording waybill', id, e)
        }
        return w
      })
      .catch((e: Error) => {
        if (owner === su) failedAt.set(id, Date.now())
        throw e
      })
      .finally(() => reading.delete(id))
    reading.set(id, p)
    return p
  },

  /** Reads these waybills in the background unless they are held (or failed moments ago). */
  want(ids: number[]) {
    if (!sameOwner()) return
    enqueue(ids.filter((id) => !waybills.has(id) && !reading.has(id)))
  },

  /** Reads this waybill again in the background (its state is known to have changed). */
  stale(id: number) {
    if (!sameOwner()) return
    enqueue([id], true)
  },

  /** Asks RS.ge which waybills changed and reads the ones held here again. Joins a check in progress. */
  checkChanges(): Promise<void> {
    if (!sameOwner()) return Promise.resolve()
    if (changes.loading) return changes.loading
    const su = owner
    const p = checkChanges()
      .catch((e: Error) => {
        if (owner === su) changes = { ...changes, error: e.message }
        bump()
        throw e
      })
      .finally(() => {
        if (owner === su) changes = { ...changes, tried: Date.now(), loading: null }
      })
    changes = { ...changes, loading: p }
    return p
  },
  changesStatus: () => ({ to: changes.to ? new Date(changes.to).toISOString() : undefined, error: changes.error }),

  /** Registers what runs for each waybill read that belongs to a shipment. */
  onWaybill(fn: typeof onWaybill) {
    onWaybill = fn
  },
}

