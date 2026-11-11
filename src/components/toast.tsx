import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { uid } from '../lib/util'

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
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:pt-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="material animate-drop-in pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-[18px] px-4 py-3 text-[15px] text-slate-900 shadow-[0_8px_32px_rgba(0,0,0,0.16)] ring-[0.5px] ring-black/5 dark:ring-white/10"
          >
            {t.kind === 'success' ? (
              <CheckCircle2 className="size-6 shrink-0 fill-emerald-500 text-white" />
            ) : t.kind === 'error' ? (
              <AlertCircle className="size-6 shrink-0 fill-rose-500 text-white" />
            ) : (
              <Info className="size-6 shrink-0 fill-brand-500 text-white" />
            )}
            <span className="leading-snug">{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
