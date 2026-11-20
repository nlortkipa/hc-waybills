import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { auth } from './api'
import { getToken, onAuthLost } from './api/client'
import { useDb, useDbLoaded } from './api/store'
import type { User } from './types'

interface Session {
  user: User | null
  /** True while a saved login is being restored from the server. */
  restoring: boolean
  login: (phone: string, code: string) => Promise<void>
  logout: () => void
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(() => !!getToken())
  const d = useDb()
  const loaded = useDbLoaded()
  // Always read the user from the synced data so admin edits (e.g. carrier change) apply live.
  const user = (loaded && d.users.find((u) => u.id === userId && !u.deletedAt)) || null

  useEffect(() => {
    if (!getToken()) return
    auth.current().then((u) => {
      setUserId(u?.id ?? null)
      setRestoring(false)
    })
  }, [])
  useEffect(() => {
    const off = onAuthLost(() => setUserId(null))
    return () => void off()
  }, [])

  const login = useCallback(async (phone: string, code: string) => {
    const u = await auth.login(phone, code)
    setUserId(u.id)
  }, [])
  const logout = useCallback(() => {
    void auth.logout()
    setUserId(null)
  }, [])

  const value = useMemo(() => ({ user, restoring: restoring || (!!userId && !loaded), login, logout }), [user, restoring, userId, loaded, login, logout])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession outside provider')
  return s
}

/** For pages that are only reachable when logged in. */
export function useUser(): User {
  const { user } = useSession()
  if (!user) throw new Error('Not logged in')
  return user
}

export const roleLabel: Record<User['role'], string> = {
  admin: 'ადმინისტრატორი',
  operator: 'ოპერატორი',
  report: 'რეპორტ მომხმარებელი',
}
