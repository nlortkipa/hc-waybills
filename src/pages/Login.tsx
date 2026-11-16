import { Truck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AppDownloadButton } from '../components/AppDownload'
import { Button } from '../components/ui'
import { phoneKey } from '../lib/util'
import { useSession } from '../session'

/**
 * Phone-number login. Today a known number logs in immediately; later an SMS code
 * will be sent here and checked in a second step before the session starts.
 */
export function Login() {
  const { login } = useSession()
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const valid = /^5\d{8}$/.test(phoneKey(phone))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!valid) {
      setError('შეიყვანე 9-ნიშნა მობილურის ნომერი (5XX XX XX XX)')
      return
    }
    setBusy(true)
    try {
      await login(phone)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="pt-safe flex min-h-full items-start justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:items-center sm:py-12">
      <div className="animate-pop-in w-full max-w-[380px] pt-14 sm:pt-0">
        <div className="flex flex-col items-center text-center">
          <span className="grid size-16 place-items-center rounded-[22%] bg-gradient-to-b from-[#3d9bff] to-[#0062e0] text-white shadow-[0_6px_18px_rgba(0,98,224,0.28),inset_0_0.5px_0_rgba(255,255,255,0.4)]">
            <Truck className="size-8" strokeWidth={2} />
          </span>
          <h1 className="mt-5 text-[22px] font-bold tracking-tight text-slate-900">HC Portal</h1>
          <p className="mt-1 text-[15px] text-slate-500">შესასვლელად შეიყვანე ტელეფონის ნომერი</p>
        </div>

        <form onSubmit={submit} className="mt-8" noValidate>
          <div className={`flex items-center overflow-hidden rounded-xl bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow ${error ? 'ring-2 ring-rose-500/50' : ''}`}>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              autoFocus
              placeholder="5XX XX XX XX"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value)
                setError(null)
              }}
              className="block h-12 w-full bg-transparent px-4 text-[16px] tabular-nums text-slate-900 placeholder:text-slate-400 focus:outline-none sm:text-[15px]"
            />
          </div>
          <p className={`mt-2 ml-1 min-h-[18px] text-[13px] text-rose-600 transition-opacity ${error ? 'opacity-100' : 'opacity-0'}`} role="alert">
            {error}
          </p>
          <Button type="submit" size="lg" className="mt-2 w-full" loading={busy} disabled={busy || !phoneKey(phone)}>
            შესვლა
          </Button>
        </form>

        <AppDownloadButton className="mt-10" />
      </div>
    </div>
  )
}
