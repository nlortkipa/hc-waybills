import { BarChart3, ChevronRight, FileText, Loader2, MessageSquare, Scale, ShieldCheck, Truck, UserCog } from 'lucide-react'
import { useState } from 'react'
import { Avatar } from '../components/ui'
import { useToast } from '../components/toast'
import { initials } from '../lib/util'
import { useDb } from '../mock/db'
import { roleLabel, useSession } from '../session'
import type { Role } from '../types'

const roleInfo: Record<Role, { icon: typeof ShieldCheck; text: string; tone: string }> = {
  admin: { icon: ShieldCheck, text: 'მართავს ცნობარებს და მომხმარებლებს, ხედავს ყველაფერს.', tone: 'bg-violet-500' },
  operator: { icon: UserCog, text: 'მიბმულია ერთ კარიერზე. ქმნის რეისებს და ტვირთავს ზედნადებებს.', tone: 'bg-brand-500' },
  report: { icon: BarChart3, text: 'ხედავს რეისებს და რეპორტებს, ცვლილების უფლების გარეშე.', tone: 'bg-emerald-500' },
}

const flow = [
  { icon: FileText, label: 'ზედნადები RS.ge-ზე', text: 'ერთი ღილაკით ატვირთვა და ნომრის მიღება.', tint: 'text-brand-600' },
  { icon: MessageSquare, label: 'SMS მძღოლს', text: 'მძღოლი მაშინვე იღებს შეტყობინებას.', tint: 'text-emerald-600' },
  { icon: Scale, label: 'რეალური წონა', text: 'სასწორი აბრუნებს აწონვის შედეგს.', tint: 'text-amber-600' },
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
    <div className="pt-safe min-h-full">
      <div className="mx-auto grid max-w-5xl gap-10 px-4 pt-12 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:items-start lg:gap-16 lg:pt-24">
        {/* Welcome */}
        <div className="animate-slide-up lg:sticky lg:top-24">
          <span className="grid size-[76px] place-items-center rounded-[22%] bg-gradient-to-b from-[#3d9bff] to-[#0062e0] text-white shadow-[0_8px_24px_rgba(0,98,224,0.3),inset_0_0.5px_0_rgba(255,255,255,0.4)]">
            <Truck className="size-10" strokeWidth={2} />
          </span>
          <h1 className="mt-6 text-[34px] leading-[1.1] font-bold tracking-[-0.02em] text-slate-900 sm:text-[40px]">მანქანიდან სასწორამდე — ერთი ღილაკით.</h1>
          <p className="mt-3 text-[17px] text-slate-500">HC Portal — კარიერი და ზედნადები</p>
          <ul className="mt-8 space-y-5">
            {flow.map((f) => (
              <li key={f.label} className="flex items-start gap-4">
                <f.icon className={`mt-0.5 size-7 shrink-0 ${f.tint}`} strokeWidth={1.75} />
                <div>
                  <p className="text-[15px] font-semibold text-slate-900">{f.label}</p>
                  <p className="text-[15px] text-slate-500">{f.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-[13px] text-slate-500">სადემონსტრაციო ვერსია — ყველა გარე სერვისი იმიტირებულია.</p>
        </div>

        {/* User picker — inset grouped list */}
        <div className="animate-slide-up">
          <h2 className="px-4 text-[22px] font-bold tracking-tight text-slate-900">აირჩიე მომხმარებელი</h2>
          <p className="mt-1 mb-6 px-4 text-[15px] text-slate-500">თითოეული როლი აპლიკაციის სხვადასხვა ნაწილს ხედავს. მომხმარებლის შეცვლა ნებისმიერ დროს შეგიძლია მენიუდან.</p>

          <div className="space-y-7">
            {roles.map((role) => {
              const users = d.users.filter((u) => u.role === role)
              if (!users.length) return null
              const info = roleInfo[role]
              return (
                <section key={role}>
                  <h3 className="mb-1.5 flex items-center gap-2 px-4 text-[13px] text-slate-500 uppercase">
                    <span className={`grid size-5 place-items-center rounded-[5px] text-white ${info.tone}`}>
                      <info.icon className="size-3" />
                    </span>
                    {roleLabel[role]}
                  </h3>
                  <div className="overflow-hidden rounded-xl bg-surface">
                    {users.map((u, i) => {
                      const carrier = d.carriers.find((c) => c.id === u.carrierId)
                      return (
                        <button key={u.id} onClick={() => pick(u.id)} disabled={!!busy} className="flex w-full items-center gap-3 pl-4 text-left transition-colors hover:bg-slate-500/5 active:bg-slate-500/15 disabled:opacity-60">
                          <Avatar text={initials(u.firstName, u.lastName)} className="size-10" />
                          <div className={`flex min-w-0 flex-1 items-center gap-2 self-stretch py-2.5 pr-4 ${i < users.length - 1 ? 'hairline-b' : ''}`}>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[17px] text-slate-900">
                                {u.firstName} {u.lastName}
                              </p>
                              <p className="truncate text-[13px] text-slate-500">{carrier?.name ?? u.email}</p>
                            </div>
                            {busy === u.id ? <Loader2 className="size-4 animate-spin text-slate-400" /> : <ChevronRight className="size-4 text-slate-400" strokeWidth={2.5} />}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1.5 px-4 text-[13px] text-slate-500">{info.text}</p>
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
