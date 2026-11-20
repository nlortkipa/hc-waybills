/**
 * HTTP client for the HC API server (server/index.ts).
 *
 * The API lives on the same origin (Vite proxies /api in dev, the server serves the
 * site in production, and the Android app opens the site from the server).
 * VITE_API_URL can point a build at an API on another origin.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

const TOKEN_KEY = 'hc.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

const authLost = new Set<() => void>()
/** Called when the server rejects the token (expired, user deleted, logged out elsewhere). */
export function onAuthLost(fn: () => void): () => void {
  authLost.add(fn)
  return () => void authLost.delete(fn)
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken()
  let res: Response
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    })
  } catch {
    throw new Error(`სერვერთან კავშირი ვერ დამყარდა${API_URL ? ` (${API_URL})` : ''}`)
  }
  if (res.status === 401 && token) {
    setToken(null)
    authLost.forEach((f) => f())
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `სერვერის შეცდომა (${res.status})`)
  return data as T
}
