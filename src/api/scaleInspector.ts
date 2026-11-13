/**
 * Client for the read-only Scale Service inspector (services/scale/inspector).
 * Unlike integrations.ts this talks to a real backend: the Docker stack started
 * with `npm run scale up`. When it isn't running, the page and nav entry hide.
 */
import { useEffect, useState } from 'react'

const BASE: string = (import.meta.env.VITE_SCALE_INSPECTOR_URL as string | undefined) ?? (import.meta.env.DEV ? 'http://localhost:5081' : '')

export const scaleInspectorUrl = BASE
export const scaleApiUrl: string = (import.meta.env.VITE_SCALE_API_URL as string | undefined) ?? (import.meta.env.DEV ? 'http://localhost:5080' : '')

export interface ScaleStatus {
  api: { up: boolean; status?: number; swagger?: boolean; ms?: number; error?: string }
  db: { up: boolean; name?: string; version?: string; error?: string }
}

export interface ScaleTable {
  schema: string
  name: string
  rows: number
  columns: number
}

export interface ScaleColumn {
  name: string
  type: string
  maxLength: number
  nullable: boolean
  identity: boolean
  pk: boolean
}

export type ScaleRow = Record<string, string | number | boolean | null>

export interface ScaleTablePage {
  schema: string
  table: string
  columns: ScaleColumn[]
  rows: ScaleRow[]
  total: number
  limit: number
  offset: number
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!BASE) throw new Error('VITE_SCALE_INSPECTOR_URL is not set')
  const res = await fetch(BASE + path, { signal })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export const scaleInspector = {
  status: (signal?: AbortSignal) => get<ScaleStatus>('/api/status', signal),
  tables: (signal?: AbortSignal) => get<ScaleTable[]>('/api/tables', signal),
  table: (schema: string, table: string, opts: { limit: number; offset: number; sort?: string; dir?: 'asc' | 'desc'; q?: string }, signal?: AbortSignal) => {
    const p = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) })
    if (opts.sort) p.set('sort', opts.sort)
    if (opts.dir) p.set('dir', opts.dir)
    if (opts.q) p.set('q', opts.q)
    return get<ScaleTablePage>(`/api/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}?${p}`, signal)
  },
}

/* One shared poller so the nav item and the page agree without double-fetching. */
type Snapshot = { status: ScaleStatus | null; checked: boolean }
let snapshot: Snapshot = { status: null, checked: false }
const listeners = new Set<(s: Snapshot) => void>()
let timer: ReturnType<typeof setInterval> | undefined

async function poll() {
  let status: ScaleStatus | null = null
  try {
    status = await scaleInspector.status(AbortSignal.timeout(5000))
  } catch {
    status = null
  }
  snapshot = { status, checked: true }
  listeners.forEach((l) => l(snapshot))
}

export function refreshScaleStatus() {
  return poll()
}

/** Inspector status, polled every 10 s while any component is subscribed. */
export function useScaleStatus(): Snapshot & { online: boolean } {
  const [s, setS] = useState(snapshot)
  useEffect(() => {
    if (!BASE) return
    listeners.add(setS)
    if (listeners.size === 1) {
      void poll()
      timer = setInterval(poll, 10_000)
    }
    return () => {
      listeners.delete(setS)
      if (listeners.size === 0) clearInterval(timer)
    }
  }, [])
  return { ...s, online: !!s.status?.api.up && !!s.status.db.up }
}
