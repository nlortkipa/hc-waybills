let counter = 0

/** Works in non-secure contexts too (e.g. phone opening the dev server over LAN). */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 1e6
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + counter.toString(36)
}

/** Drops soft-deleted records — use for lists and pickers, never for resolving history. */
export const active = <T extends { deletedAt?: string }>(xs: T[]): T[] => xs.filter((x) => !x.deletedAt)

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const nowIso = () => new Date().toISOString()

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
  const d = new Date(iso)
  return `${formatDay(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
