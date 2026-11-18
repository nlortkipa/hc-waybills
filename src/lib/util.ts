import type { Shipment } from '../types.ts'

let counter = 0

/** Works in non-secure contexts too (e.g. phone opening the dev server over LAN). */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 1e6
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + counter.toString(36)
}

/** Drops soft-deleted records — use for lists and pickers, never for resolving history. */
export const active = <T extends { deletedAt?: string }>(xs: T[]): T[] => xs.filter((x) => !x.deletedAt)

/** Same ids, in any order. */
export const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

/** Whether a shipment references a reference record (deleting it then only retires it). */
export function shipmentUses(s: Shipment, col: 'carriers' | 'routes' | 'drivers' | 'trucks' | 'products' | 'users', id: string): boolean {
  if (col === 'products') return (s.items ?? []).some((i) => i.productId === id)
  return s[({ carriers: 'carrierId', routes: 'routeId', drivers: 'driverId', trucks: 'truckId', users: 'createdBy' } as const)[col]] === id
}


export const nowIso = () => new Date().toISOString()

/*
 * Every date shown or grouped by day is in Georgian time, whatever the device's time zone.
 * Georgia is UTC+4 all year (no daylight saving), so a fixed offset is exact.
 */
const TBILISI_OFFSET_MS = 4 * 3600_000
/** A Date whose UTC fields read as the wall clock in Tbilisi. Only for reading fields, not for arithmetic. */
const tbilisi = (d: Date | string) => new Date(new Date(d).getTime() + TBILISI_OFFSET_MS)

/** `YYYY-MM-DD` of the Georgian calendar day of an instant (default: now). */
export const tbilisiDay = (d: Date | string = new Date()) => tbilisi(d).toISOString().slice(0, 10)

/** `YYYY-MM-DD HH:MM` in Georgian time, for exports. */
export const tbilisiStamp = (iso: string) => tbilisi(iso).toISOString().slice(0, 16).replace('T', ' ')

/** Georgian mobile number reduced to its 9 local digits ('+995 575 78 03 23' → '575780323'). */
export const phoneKey = (v: string) => v.replace(/\D/g, '').replace(/^995(?=\d{9}$)/, '')

/*
 * Georgian formatting done by hand: some WebViews / headless browsers ship without
 * full locale data, so Intl('ka-GE') can silently fall back to English.
 */
const MONTHS = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ']
const pad = (n: number) => String(n).padStart(2, '0')

export function formatDay(d: Date, utc = false): string {
  return utc ? `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}` : `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '—'
  const d = tbilisi(iso)
  return `${formatDay(d, true)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function formatTime(iso?: string): string {
  if (!iso) return '—'
  const d = tbilisi(iso)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'ახლახან'
  if (s < 3600) return `${Math.floor(s / 60)} წთ-ის წინ`
  if (s < 86400) return `${Math.floor(s / 3600)} სთ-ის წინ`
  return `${Math.floor(s / 86400)} დღის წინ`
}

/** 23961 → "23 961", 24.55 → "24,55" (Georgian style). */
export function formatNumber(n: number, maxDecimals = 0): string {
  const f = 10 ** maxDecimals
  const r = Math.round(Math.abs(n) * f) / f
  const [int, dec] = String(r).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  return (n < 0 ? '-' : '') + grouped + (dec ? ',' + dec : '')
}

export const formatKg = (kg?: number) => (kg == null ? '—' : `${formatNumber(kg)} კგ`)
export const formatTonnes = (t: number) => `${formatNumber(t, 2)} ტ`

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function initials(first: string, last: string) {
  return (first[0] ?? '') + (last[0] ?? '')
}

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** An instant as a `datetime-local` value (`YYYY-MM-DDTHH:MM`) in Georgian time. */
export const toTbilisiInput = (d: Date | string = new Date()) => tbilisi(d).toISOString().slice(0, 16)

/** A `datetime-local` value read as Georgian time, as ISO (UTC); '' when empty or invalid. */
export function fromTbilisiInput(v: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(v)) return ''
  const t = Date.parse(`${v}:00+04:00`)
  return Number.isFinite(t) ? new Date(t).toISOString() : ''
}
