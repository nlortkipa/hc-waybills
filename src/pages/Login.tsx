import { ChevronLeft, Truck } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { auth } from '../api'
import { AppDownloadButton } from '../components/AppDownload'
import { Button } from '../components/ui'
import { cx, phoneKey } from '../lib/util'
import '../lib/save'
import { useSession } from '../session'

const CODE_LEN = 6

/** "575780323" → "575 78 03 23". */
const prettyPhone = (k: string) => k.replace(/^(\d{3})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4')

/**
 * Waits for the login SMS and hands its code over: the SMS User Consent prompt in the Android app
 * (MainActivity dispatches `hc-otp`). iOS and other keyboards offer the code themselves through
 * autocomplete="one-time-code".
 */
function useSmsCode(active: boolean, onCode: (code: string) => void) {
  const cb = useRef(onCode)
  cb.current = onCode
  useEffect(() => {
    if (!active) return
    const onNative = (e: Event) => {
      const code = String((e as CustomEvent<string>).detail ?? '').replace(/\D/g, '').slice(0, CODE_LEN)
      if (code.length === CODE_LEN) cb.current(code)
    }
    window.addEventListener('hc-otp', onNative)
    try {
      window.HCNative?.listenForSmsCode?.()
    } catch {
      /* older app without the bridge */
    }
    return () => window.removeEventListener('hc-otp', onNative)
  }, [active])
}

/** Phone-number login: the server texts a 6-digit code, which starts the session. */
export function Login() {
  const { login } = useSession()
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const codeRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)

  const key = phoneKey(phone)
  const valid = /^5\d{8}$/.test(key)
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000))

  useEffect(() => {
    if (step !== 'code' || !wait) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [step, wait])

  const requestCode = async () => {
    setError(null)
    setBusy(true)
    try {
      const resendIn = await auth.sendCode(key)
      setResendAt(Date.now() + resendIn * 1000)
      setNow(Date.now())
      setCode('')
      setStep('code')
      setTimeout(() => codeRef.current?.focus(), 50)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitPhone = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) {
      setError('შეიყვანე 9-ნიშნა მობილურის ნომერი (5XX XX XX XX)')
      return
    }
    void requestCode()
  }

  const verify = async (c: string) => {
    if (c.length !== CODE_LEN || busy) return
    setError(null)
    setBusy(true)
    try {
      await login(key, c)
    } catch (err) {
      setError((err as Error).message)
      setCode('')
      setBusy(false)
      setTimeout(() => codeRef.current?.focus(), 30)
    }
  }

  const onCode = (v: string) => {
    const c = v.replace(/\D/g, '').slice(0, CODE_LEN)
    setCode(c)
    setError(null)
    if (c.length === CODE_LEN) void verify(c)
  }
  useSmsCode(step === 'code', onCode)

  return (
    <div className="pt-safe flex min-h-full items-start justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:items-center sm:py-12">
      <div className="animate-pop-in w-full max-w-[380px] pt-14 sm:pt-0">
        <div className="flex flex-col items-center text-center">
          <span className="grid size-16 place-items-center rounded-[22%] bg-gradient-to-b from-[#3d9bff] to-[#0062e0] text-white shadow-[0_6px_18px_rgba(0,98,224,0.28),inset_0_0.5px_0_rgba(255,255,255,0.4)]">
            <Truck className="size-8" strokeWidth={2} />
          </span>
          <h1 className="mt-5 text-[22px] font-bold tracking-tight text-slate-900">HC Portal</h1>
          <p className="mt-1 text-[15px] text-slate-500">
            {step === 'phone' ? (
              'შესასვლელად შეიყვანე ტელეფონის ნომერი'
            ) : (
              <>
                კოდი გაიგზავნა ნომერზე <span className="font-semibold whitespace-nowrap text-slate-900 tabular-nums">{prettyPhone(key)}</span>
              </>
            )}
          </p>
        </div>

        {step === 'phone' ? (
          <form onSubmit={submitPhone} className="mt-8" noValidate>
            <div className={cx('flex items-center overflow-hidden rounded-xl bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow', error && 'ring-2 ring-rose-500/50')}>
              <span className="pl-4 text-[16px] text-slate-400 tabular-nums select-none sm:text-[15px]">+995</span>
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
                className="block h-12 w-full bg-transparent px-3 text-[16px] tabular-nums text-slate-900 placeholder:text-slate-400 focus:outline-none sm:text-[15px]"
              />
            </div>
            <p className={cx('mt-2 ml-1 min-h-[18px] text-[13px] text-rose-600 transition-opacity', error ? 'opacity-100' : 'opacity-0')} role="alert">
              {error}
            </p>
            <Button type="submit" size="lg" className="mt-2 w-full" loading={busy} disabled={busy || !key}>
              კოდის მიღება
            </Button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void verify(code)
            }}
            className="mt-8"
            noValidate
          >
            <label className="relative block" onClick={() => codeRef.current?.focus()}>
              <span className="sr-only">SMS კოდი</span>
              <input
                ref={codeRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d*"
                maxLength={CODE_LEN}
                autoFocus
                value={code}
                disabled={busy}
                onChange={(e) => onCode(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                className="absolute inset-0 z-10 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 focus:outline-none"
              />
              <div className="grid grid-cols-6 gap-2" aria-hidden>
                {Array.from({ length: CODE_LEN }, (_, i) => {
                  const current = i === Math.min(code.length, CODE_LEN - 1)
                  return (
                    <div
                      key={i}
                      className={cx(
                        'grid h-14 place-items-center rounded-xl bg-surface text-[24px] font-semibold text-slate-900 tabular-nums shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow',
                        error ? 'ring-2 ring-rose-500/50' : current && focused && 'ring-2 ring-brand-500/60',
                      )}
                    >
                      {code[i] ?? ''}
                    </div>
                  )
                })}
              </div>
            </label>
            <p className={cx('mt-2 ml-1 min-h-[18px] text-[13px] text-rose-600 transition-opacity', error ? 'opacity-100' : 'opacity-0')} role="alert">
              {error}
            </p>
            <Button type="submit" size="lg" className="mt-2 w-full" loading={busy} disabled={busy || code.length !== CODE_LEN}>
              შესვლა
            </Button>
            <div className="mt-4 flex items-center justify-between text-[15px]">
              <button
                type="button"
                className="pressable inline-flex items-center gap-0.5 font-medium text-brand-600"
                onClick={() => {
                  setStep('phone')
                  setError(null)
                  setCode('')
                }}
              >
                <ChevronLeft className="size-4" strokeWidth={2.5} />
                ნომრის შეცვლა
              </button>
              <button type="button" className="pressable font-medium text-brand-600 disabled:text-slate-400" disabled={busy || wait > 0} onClick={() => void requestCode()}>
                {wait > 0 ? `ხელახლა · ${wait}წმ` : 'ხელახლა გაგზავნა'}
              </button>
            </div>
          </form>
        )}

        <AppDownloadButton className="mt-10" />
      </div>
    </div>
  )
}
