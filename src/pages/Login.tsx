import { ArrowRight, BarChart3, FileText, Loader2, MessageSquare, Scale, ShieldCheck, Truck, UserCog } from 'lucide-react'
import { useState } from 'react'
import { Avatar } from '../components/ui'
import { useToast } from '../components/toast'
import { initials } from '../lib/util'
import { useDb } from '../mock/db'
import { roleLabel, useSession } from '../session'
import type { Role } from '../types'

const roleInfo: Record<Role, { icon: typeof ShieldCheck; text: string; tone: string }> = {
  admin: { icon: ShieldCheck, text: 'მართავს ცნობარებს და მომხმარებლებს, ხედავს ყველაფერს.', tone: 'bg-violet-50 text-violet-700' },
  operator: { icon: UserCog, text: 'მიბმულია ერთ კარიერზე. ქმნის რეისებს და ტვირთავს ზედნადებებს.', tone: 'bg-brand-50 text-brand-700' },
  report: { icon: BarChart3, text: 'ხედავს რეისებს და რეპორტებს, ცვლილების უფლების გარეშე.', tone: 'bg-emerald-50 text-emerald-700' },
}

const flow = [
  { icon: FileText, label: 'ზედნადები → RS.ge' },
  { icon: MessageSquare, label: 'SMS → მძღოლს' },
  { icon: Scale, label: 'სასწორი → რეალური წონა' },
]

export function Login() {
  const d = useDb()
  const { login } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const roles: Role[] = ['admin', 'operator', 'report']

  const pick = async (id: string) => {
    setBusy(id)
    try {
      await login(id)
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* Brand panel */}
      <div className="relative overflow-hidden bg-gradient-to-br from-brand-700 via-brand-800 to-brand-950 px-6 pb-8 text-white lg:flex lg:w-[44%] lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -top-24 -right-24 size-80 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 size-96 rounded-full bg-white/5" />
        <div className="pt-safe" />
        <div className="relative flex items-center gap-3 pt-6 lg:pt-0">
          <div className="grid size-10 place-items-center rounded-xl bg-white/15 ring-1 ring-white/20">
            <Truck className="size-5" />
          </div>
          <div>
            <p className="font-semibold">HC Portal</p>
            <p className="text-xs text-brand-200">კარიერი და ზედნადები</p>
          </div>
        </div>
        <div className="relative mt-8 lg:mt-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl lg:text-4xl">მანქანიდან სასწორამდე — ერთი ღილაკით.</h1>
          <p className="mt-3 max-w-md text-sm text-brand-100 sm:text-base">მოამზადე რეისი, ატვირთე ზედნადები RS.ge-ზე, შეატყობინე მძღოლს და მიიღე რეალური წონა სასწორიდან.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {flow.map((f, i) => (
              <div key={f.label} className="flex items-center gap-2">
                <span className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium ring-1 ring-white/15">
                  <f.icon className="size-3.5" />
                  {f.label}
                </span>
                {i < flow.length - 1 && <ArrowRight className="hidden size-3.5 text-brand-300 sm:block" />}
              </div>
            ))}
          </div>
        </div>
        <p className="relative mt-8 hidden text-xs text-brand-300 lg:block">სადემონსტრაციო ვერსია — ყველა გარე სერვისი იმიტირებულია.</p>
      </div>

      {/* User picker */}
      <div className="flex flex-1 items-start justify-center px-4 pt-8 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-6 lg:items-center lg:py-12">
        <div className="w-full max-w-xl">
          <div className="mb-6">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">სატესტო შესვლა</span>
            <h2 className="mt-3 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">აირჩიე მომხმარებელი შესასვლელად</h2>
            <p className="mt-1 text-sm text-slate-500">თითოეული როლი აპლიკაციის სხვადასხვა ნაწილს ხედავს. მომხმარებლის შეცვლა ნებისმიერ დროს შეგიძლია მენიუდან.</p>
          </div>

          <div className="space-y-6">
            {roles.map((role) => {
              const users = d.users.filter((u) => u.role === role)
              if (!users.length) return null
              const info = roleInfo[role]
              return (
                <section key={role}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className={`grid size-6 place-items-center rounded-md ${info.tone}`}>
                      <info.icon className="size-3.5" />
                    </span>
                    <h3 className="text-sm font-semibold text-slate-800">{roleLabel[role]}</h3>
                    <span className="hidden text-xs text-slate-400 sm:inline">— {info.text}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {users.map((u) => {
                      const carrier = d.carriers.find((c) => c.id === u.carrierId)
                      return (
                        <button
                          key={u.id}
                          onClick={() => pick(u.id)}
                          disabled={!!busy}
                          className="group flex items-center gap-3 rounded-2xl bg-white p-3 text-left ring-1 ring-slate-200 transition hover:ring-2 hover:ring-brand-400 disabled:opacity-60"
                        >
                          <Avatar text={initials(u.firstName, u.lastName)} className="size-10" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-900">
                              {u.firstName} {u.lastName}
                            </p>
                            <p className="truncate text-xs text-slate-500">{carrier?.name ?? u.email}</p>
                          </div>
                          {busy === u.id ? (
                            <Loader2 className="size-4 animate-spin text-brand-500" />
                          ) : (
                            <ArrowRight className="size-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" />
                          )}
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
