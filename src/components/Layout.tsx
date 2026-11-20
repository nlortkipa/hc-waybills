import { BarChart3, ChevronRight, Database, FileStack, LayoutDashboard, LogOut, PlusCircle, Truck, Waypoints, X, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useDb } from '../api/store'
import { userCarriers } from '../api'
import { cx, initials } from '../lib/util'
import { roleLabel, useSession, useUser } from '../session'
import type { Role } from '../types'
import { AppDownloadButton } from './AppDownload'
import { Avatar } from './ui'

interface NavItem {
  to: string
  label: string
  short?: string
  icon: LucideIcon
  roles: Role[]
  /** Settings-style icon tile color. */
  tint: string
  /** Shown in the mobile bottom bar for these roles. */
  mobile: Role[]
}

export const NAV: NavItem[] = [
  { to: '/', tint: 'bg-brand-500', label: 'მთავარი', short: 'მთავარი', icon: LayoutDashboard, roles: ['admin', 'operator'], mobile: ['admin', 'operator'] },
  { to: '/new', tint: 'bg-emerald-500', label: 'ახალი რეისი', short: 'ახალი', icon: PlusCircle, roles: ['admin', 'operator'], mobile: ['operator'] },
  { to: '/shipments', tint: 'bg-amber-500', label: 'რეისები', icon: Truck, roles: ['admin', 'operator', 'report'], mobile: ['admin', 'operator', 'report'] },
  { to: '/waybills', tint: 'bg-indigo-500', label: 'RS.ge ზედნადებები', short: 'RS.ge', icon: FileStack, roles: ['admin', 'report'], mobile: ['report'] },
  { to: '/reports', tint: 'bg-violet-500', label: 'რეპორტები', icon: BarChart3, roles: ['admin', 'report'], mobile: ['admin', 'report'] },
  { to: '/refs', tint: 'bg-slate-500', label: 'ცნობარები', short: 'ცნობარები', icon: Database, roles: ['admin'], mobile: ['admin'] },
  { to: '/logs', tint: 'bg-rose-500', label: 'API მოთხოვნები', short: 'API', icon: Waypoints, roles: ['admin', 'operator', 'report'], mobile: ['report'] },
]

function AppIcon({ className }: { className?: string }) {
  return (
    <span className={cx('grid place-items-center rounded-[22%] bg-gradient-to-b from-[#3d9bff] to-[#0062e0] text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)]', className)}>
      <Truck className="size-[55%]" strokeWidth={2.25} />
    </span>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <AppIcon className="size-8" />
      <div className="leading-tight">
        <p className="text-[15px] font-semibold text-slate-900">HC Portal</p>
        <p className="text-xs text-slate-500">კარიერი და ზედნადები</p>
      </div>
    </div>
  )
}

function useAccount() {
  const user = useUser()
  const d = useDb()
  const names = user.role === 'operator' ? userCarriers(d, user).map((c) => c.name) : []
  return { user, sub: names.length ? `${roleLabel[user.role]} · ${names.join(', ')}` : roleLabel[user.role] }
}

function SidebarAccount({ onLogout }: { onLogout: () => void }) {
  const { user, sub } = useAccount()
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] p-2">
      <Avatar text={initials(user.firstName, user.lastName)} className="size-8 text-xs" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-slate-900">
          {user.firstName} {user.lastName}
        </p>
        <p className="truncate text-xs text-slate-500">{sub}</p>
      </div>
      <button onClick={onLogout} className="pressable grid size-8 place-items-center rounded-full text-slate-500 hover:bg-fill hover:text-slate-900" title="მომხმარებლის შეცვლა" aria-label="გასვლა">
        <LogOut className="size-4" />
      </button>
    </div>
  )
}

/** Inset-grouped list row (Settings app style). */
function SheetRow({ icon: Icon, tint, label, onClick, to, destructive, last }: { icon: LucideIcon; tint: string; label: string; onClick?: () => void; to?: string; destructive?: boolean; last?: boolean }) {
  const inner = (
    <>
      <span className={cx('grid size-[29px] shrink-0 place-items-center rounded-[7px] text-white', tint)}>
        <Icon className="size-[17px]" />
      </span>
      <span className={cx('flex flex-1 items-center gap-2 self-stretch py-3 pr-3 text-[17px]', !last && 'hairline-b', destructive ? 'text-rose-600' : 'text-slate-900')}>
        <span className="flex-1">{label}</span>
        {!destructive && <ChevronRight className="size-4 text-slate-400" strokeWidth={2.5} />}
      </span>
    </>
  )
  const cls = 'flex w-full items-center gap-3 pl-4 text-left active:bg-slate-500/15'
  return to ? (
    <NavLink to={to} end={to === '/'} onClick={onClick} className={cls}>
      {inner}
    </NavLink>
  ) : (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, sub } = useAccount()
  const { logout } = useSession()
  const loc = useLocation()
  const items = NAV.filter((n) => n.roles.includes(user.role))
  const mobileItems = items.filter((n) => n.mobile.includes(user.role))
  const [menuOpen, setMenuOpen] = useState(false)
  const current = items.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)))

  // Nav bar picks up its hairline + material only once content scrolls under it (iOS behavior).
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    window.scrollTo(0, 0)
    setMenuOpen(false)
  }, [loc.pathname])
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  return (
    <div className="min-h-full lg:pl-[260px]">
      {/* iPadOS-style sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col bg-surface/60 shadow-[inset_-0.5px_0_0_var(--ios-separator)] lg:flex">
        <div className="px-5 pt-6 pb-5">
          <Brand />
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx('flex h-10 items-center gap-3 rounded-[10px] px-3 text-[15px] transition-colors', isActive ? 'bg-brand-600 font-semibold text-white' : 'text-slate-900 hover:bg-fill')
              }
            >
              {({ isActive }) => (
                <>
                  <n.icon className={cx('size-[19px]', isActive ? 'text-white' : 'text-brand-600')} />
                  {n.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="p-3">
          <SidebarAccount onLogout={logout} />
        </div>
      </aside>

      {/* iOS navigation bar */}
      <header className={cx('pt-safe sticky top-0 z-30 transition-[background-color,box-shadow] duration-200 lg:hidden', scrolled ? 'material hairline-b' : 'bg-canvas')}>
        <div className="relative flex h-11 items-center justify-between px-4">
          <AppIcon className="size-7" />
          <p className={cx('absolute inset-x-16 truncate text-center text-[17px] font-semibold text-slate-900 transition-opacity duration-200', scrolled ? 'opacity-100' : 'opacity-0')}>{current?.label ?? 'HC Portal'}</p>
          <button onClick={() => setMenuOpen(true)} className="pressable -mr-1 rounded-full" aria-label="მენიუს გახსნა">
            <Avatar text={initials(user.firstName, user.lastName)} className="size-8 text-xs" />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+6rem)] sm:px-6 lg:px-8 lg:pt-10 lg:pb-12">
        {current && <span className="sr-only">{current.label}</span>}
        {children}
      </main>

      {/* iOS tab bar */}
      <nav className="material hairline-t pb-safe fixed inset-x-0 bottom-0 z-30 lg:hidden">
        <div className="mx-auto flex max-w-md">
          {mobileItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => cx('pressable flex h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium', isActive ? 'text-brand-600' : 'text-slate-500')}
            >
              {({ isActive }) => (
                <>
                  <n.icon className="size-6" strokeWidth={isActive ? 2.25 : 1.75} />
                  {n.short ?? n.label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Account sheet */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="animate-fade-in absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <div className="animate-sheet-up absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-[14px] bg-canvas px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
            <div className="mx-auto mt-1.5 h-[5px] w-9 rounded-full bg-slate-400/50" />
            <div className="flex items-center justify-between pt-3 pb-4">
              <h2 className="text-[17px] font-semibold text-slate-900">ანგარიში</h2>
              <button onClick={() => setMenuOpen(false)} className="pressable grid size-[30px] place-items-center rounded-full bg-fill text-slate-500" aria-label="მენიუს დახურვა">
                <X className="size-4" strokeWidth={2.5} />
              </button>
            </div>

            <div className="mb-6 flex items-center gap-3 rounded-xl bg-surface p-4">
              <Avatar text={initials(user.firstName, user.lastName)} className="size-14 text-xl" />
              <div className="min-w-0">
                <p className="truncate text-[20px] font-semibold text-slate-900">
                  {user.firstName} {user.lastName}
                </p>
                <p className="truncate text-[15px] text-slate-500">{sub}</p>
              </div>
            </div>

            <div className="mb-6 overflow-hidden rounded-xl bg-surface">
              {items.map((n, i) => (
                <SheetRow key={n.to} to={n.to} icon={n.icon} tint={n.tint} label={n.label} last={i === items.length - 1} onClick={() => setMenuOpen(false)} />
              ))}
            </div>

            <AppDownloadButton className="mb-6" />

            <div className="overflow-hidden rounded-xl bg-surface">
              <SheetRow
                icon={LogOut}
                tint="bg-rose-500"
                label="მომხმარებლის შეცვლა"
                destructive
                last
                onClick={() => {
                  setMenuOpen(false)
                  logout()
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
