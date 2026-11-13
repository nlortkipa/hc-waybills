import { ChevronRight, Loader2, Truck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Avatar, Button } from '../components/ui'
import { useToast } from '../components/toast'
import { initials } from '../lib/util'
import { useDb } from '../mock/db'
import { roleLabel, useSession } from '../session'
import type { Role } from '../types'

const roleOrder: Role[] = ['admin', 'operator', 'report']

export function Login() {
  const d = useDb()
  const { login } = useSession()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const users = d.users.filter((u) => !u.deletedAt).sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role))

  const enter = async (id: string, key = id) => {
    setBusy(key)
    try {
      await login(id)
    } catch (e) {
      toast('error', (e as Error).message)
      setBusy(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const u = d.users.find((x) => !x.deletedAt && x.email.toLowerCase() === email.trim().toLowerCase())
    if (!u || !password) {
      setError('ელ-ფოსტა ან პაროლი არასწორია')
      return
    }
    enter(u.id, 'form')
  }

  return (
    <div className="pt-safe flex min-h-full items-start justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:items-center sm:py-12">
      <div className="animate-pop-in w-full max-w-[380px] pt-14 sm:pt-0">
        {/* Header */}
        <div className="flex flex-col items-center text-center">
          <span className="grid size-16 place-items-center rounded-[22%] bg-gradient-to-b from-[#3d9bff] to-[#0062e0] text-white shadow-[0_6px_18px_rgba(0,98,224,0.28),inset_0_0.5px_0_rgba(255,255,255,0.4)]">
            <Truck className="size-8" strokeWidth={2} />
          </span>
          <h1 className="mt-5 text-[22px] font-bold tracking-tight text-slate-900">HC Portal</h1>
          <p className="mt-1 text-[15px] text-slate-500">შედით თქვენს ანგარიშზე</p>
        </div>

        {/* Form */}
        <form onSubmit={submit} className="mt-8" noValidate>
          <div className={`overflow-hidden rounded-xl bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow ${error ? 'ring-2 ring-rose-500/50' : ''}`}>
            <input
              type="email"
              autoComplete="username"
              autoFocus
              placeholder="ელ-ფოსტა"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setError(null)
              }}
              className="hairline-b block h-12 w-full bg-transparent px-4 text-[16px] text-slate-900 placeholder:text-slate-400 focus:outline-none sm:text-[15px]"
            />
            <input
              type="password"
              autoComplete="current-password"
              placeholder="პაროლი"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
              className="block h-12 w-full bg-transparent px-4 text-[16px] text-slate-900 placeholder:text-slate-400 focus:outline-none sm:text-[15px]"
            />
          </div>
          <p className={`mt-2 ml-1 min-h-[18px] text-[13px] text-rose-600 transition-opacity ${error ? 'opacity-100' : 'opacity-0'}`} role="alert">
            {error}
          </p>
          <Button type="submit" size="lg" className="mt-2 w-full" loading={busy === 'form'} disabled={!!busy || !email || !password}>
            შესვლა
          </Button>
        </form>

        {/* Quick user switch */}
        <div className="mt-10 flex items-center gap-3">
          <span className="h-px flex-1 bg-separator" />
          <span className="text-[13px] text-slate-500">ან აირჩიეთ მომხმარებელი</span>
          <span className="h-px flex-1 bg-separator" />
        </div>

        <div className="mt-4 overflow-hidden rounded-xl bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {users.map((u, i) => {
            const carrier = d.carriers.find((c) => c.id === u.carrierId)
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => enter(u.id)}
                disabled={!!busy}
                className="flex w-full items-center gap-3 pl-3.5 text-left transition-colors hover:bg-slate-500/5 active:bg-slate-500/15 disabled:opacity-60"
              >
                <Avatar text={initials(u.firstName, u.lastName)} className="size-8 text-[12px]" />
                <div className={`flex min-w-0 flex-1 items-center gap-2 self-stretch py-2 pr-3.5 ${i < users.length - 1 ? 'hairline-b' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] text-slate-900">
                      {u.firstName} {u.lastName}
                    </p>
                    <p className="truncate text-[12px] text-slate-500">
                      {roleLabel[u.role]}
                      {carrier ? ` · ${carrier.name}` : ''}
                    </p>
                  </div>
                  {busy === u.id ? <Loader2 className="size-4 animate-spin text-slate-400" /> : <ChevronRight className="size-4 text-slate-400" strokeWidth={2.5} />}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
