import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { auth } from './api'
import { useDb } from './mock/db'
import type { User } from './types'

interface Session {
  user: User | null
  login: (id: string) => Promise<void>
  logout: () => void
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(() => auth.current()?.id ?? null)
  const d = useDb()
  // Always read the user from the DB so admin edits (e.g. carrier change) apply live.
  const user = d.users.find((u) => u.id === userId) ?? null

  const login = useCallback(async (id: string) => {
    const u = await auth.loginAs(id)
    setUserId(u.id)
  }, [])
  const logout = useCallback(() => {
    auth.logout()
    setUserId(null)
  }, [])

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout])
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
