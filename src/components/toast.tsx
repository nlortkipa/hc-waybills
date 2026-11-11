import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { cx, uid } from '../lib/util'

type Kind = 'success' | 'error' | 'info'
interface Toast {
  id: string
  kind: Kind
  text: string
}

const Ctx = createContext<(kind: Kind, text: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((kind: Kind, text: string) => {
    const t = { id: uid(), kind, text }
    setToasts((x) => [...x.slice(-3), t])
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== t.id)), 3800)
  }, [])

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:px-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cx(
              'animate-slide-up pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl px-4 py-3 text-sm text-white shadow-lg',
              t.kind === 'error' ? 'bg-rose-600' : 'bg-slate-900',
            )}
          >
            {t.kind === 'success' ? <CheckCircle2 className="size-5 shrink-0 text-emerald-400" /> : t.kind === 'error' ? <AlertCircle className="size-5 shrink-0" /> : <Info className="size-5 shrink-0 text-brand-300" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
