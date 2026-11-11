import { BarChart3, Database, FlaskConical, LayoutDashboard, LogOut, Menu, PlusCircle, Truck, X, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useDb } from '../mock/db'
import { cx, initials } from '../lib/util'
import { roleLabel, useSession, useUser } from '../session'
import type { Role } from '../types'
import { Avatar } from './ui'

interface NavItem {
  to: string
  label: string
  short?: string
  icon: LucideIcon
  roles: Role[]
  /** Shown in the mobile bottom bar for these roles. */
  mobile: Role[]
}

export const NAV: NavItem[] = [
  { to: '/', label: 'მთავარი', short: 'მთავარი', icon: LayoutDashboard, roles: ['admin', 'operator'], mobile: ['admin', 'operator'] },
  { to: '/new', label: 'ახალი რეისი', short: 'ახალი', icon: PlusCircle, roles: ['admin', 'operator'], mobile: ['operator'] },
  { to: '/shipments', label: 'რეისები', icon: Truck, roles: ['admin', 'operator', 'report'], mobile: ['admin', 'operator', 'report'] },
  { to: '/reports', label: 'რეპორტები', icon: BarChart3, roles: ['admin', 'report'], mobile: ['admin', 'report'] },
  { to: '/refs', label: 'ცნობარები', short: 'ცნობარები', icon: Database, roles: ['admin'], mobile: ['admin'] },
  { to: '/mock', label: 'სატესტო პანელი', short: 'ტესტი', icon: FlaskConical, roles: ['admin', 'operator', 'report'], mobile: ['report'] },
]

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm shadow-brand-600/30">
        <Truck className="size-5" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-slate-900">HC Portal</p>
        <p className="text-[11px] text-slate-500">კარიერი და ზედნადები</p>
      </div>
    </div>
  )
}

function UserCard({ onLogout }: { onLogout: () => void }) {
  const user = useUser()
  const d = useDb()
  const carrier = d.carriers.find((c) => c.id === user.carrierId)
  return (
    <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
      <Avatar text={initials(user.firstName, user.lastName)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">
          {user.firstName} {user.lastName}
        </p>
        <p className="truncate text-xs text-slate-500">{carrier ? `${roleLabel[user.role]} · ${carrier.name}` : roleLabel[user.role]}</p>
      </div>
      <button onClick={onLogout} className="rounded-lg p-2 text-slate-400 hover:bg-white hover:text-slate-700" title="მომხმარებლის შეცვლა" aria-label="გასვლა">
        <LogOut className="size-4" />
      </button>
    </div>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const user = useUser()
  const { logout } = useSession()
  const items = NAV.filter((n) => n.roles.includes(user.role))
  const mobileItems = items.filter((n) => n.mobile.includes(user.role))
  const [menuOpen, setMenuOpen] = useState(false)
  const loc = useLocation()
  const current = items.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)))

  return (
    <div className="min-h-full lg:pl-64">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                )
              }
            >
              <n.icon className="size-[18px]" />
              {n.label}
              {n.to === '/mock' && <span className="ml-auto rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700">dev</span>}
            </NavLink>
          ))}
        </nav>
        <div className="p-3">
          <UserCard onLogout={logout} />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="pt-safe sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Brand />
          <button onClick={() => setMenuOpen(true)} className="-mr-2 flex items-center gap-2 rounded-xl p-1.5 hover:bg-slate-100" aria-label="მენიუს გახსნა">
            <Avatar text={initials(user.firstName, user.lastName)} className="size-8 text-xs" />
            <Menu className="size-5 text-slate-500" />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pt-5 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-12">
        {current && <span className="sr-only">{current.label}</span>}
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-md">
          {mobileItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => cx('flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium', isActive ? 'text-brand-600' : 'text-slate-500')}
            >
              {({ isActive }) => (
                <>
                  <span className={cx('grid h-7 w-12 place-items-center rounded-full transition-colors', isActive && 'bg-brand-50')}>
                    <n.icon className="size-5" />
                  </span>
                  {n.short ?? n.label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Mobile menu sheet */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="animate-fade-in absolute inset-0 bg-slate-900/40" onClick={() => setMenuOpen(false)} />
          <div className="animate-slide-up absolute inset-x-0 top-0 rounded-b-3xl bg-white p-4 pt-[calc(env(safe-area-inset-top)+1rem)] shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <Brand />
              <button onClick={() => setMenuOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="მენიუს დახურვა">
                <X className="size-5" />
              </button>
            </div>
            <nav className="mb-4 grid grid-cols-2 gap-2">
              {items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/'}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    cx('flex items-center gap-2.5 rounded-xl px-3 py-3 text-sm font-medium ring-1', isActive ? 'bg-brand-50 text-brand-700 ring-brand-200' : 'text-slate-700 ring-slate-200')
                  }
                >
                  <n.icon className="size-[18px]" />
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <UserCard
              onLogout={() => {
                setMenuOpen(false)
                logout()
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
