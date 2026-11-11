import { AlertCircle, CheckCircle2, CircleDashed, Loader2, MinusCircle, X } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cx } from '../lib/util'
import type { ShipmentStatus, StepStatus } from '../types'

/* ----------------------------- Button ----------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm shadow-brand-600/20 disabled:bg-brand-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-5 text-base',
        variants[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

/* ------------------------------ Card ------------------------------ */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-2xl bg-white ring-1 ring-slate-200/80 shadow-sm', className)}>{children}</div>
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}

/* ------------------------------ Form ------------------------------ */

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
    </label>
  )
}

const inputCls =
  'block w-full h-11 rounded-xl border-0 bg-white px-3 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500'

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} className={cx(inputCls, invalid && 'ring-rose-400', className)} />
}

export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...rest} className={cx(inputCls, 'appearance-none bg-[url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="%2394a3b8" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>\')] bg-[position:right_0.75rem_center] bg-no-repeat pr-9', invalid && 'ring-rose-400', className)}>
      {children}
    </select>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex items-center gap-3 text-sm text-slate-700">
      <span className={cx('relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-slate-300')}>
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
      </span>
      {label}
    </button>
  )
}

/* ----------------------------- Badges ----------------------------- */

const tone = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
}
export type Tone = keyof typeof tone

export function Badge({ tone: t = 'gray', children, dot, pulse }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', tone[t])}>
      {dot && <span className={cx('size-1.5 rounded-full bg-current', pulse && 'animate-pulse')} />}
      {children}
    </span>
  )
}

export const statusMeta: Record<ShipmentStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  uploading: { label: 'იტვირთება', tone: 'blue', pulse: true },
  rs_failed: { label: 'RS.ge შეცდომა', tone: 'red' },
  uploaded: { label: 'ატვირთულია', tone: 'blue', pulse: true },
  scale_failed: { label: 'სასწორის შეცდომა', tone: 'red' },
  at_scale: { label: 'ელოდება აწონვას', tone: 'amber', pulse: true },
  weighed: { label: 'აწონილია', tone: 'green' },
}

export function StatusBadge({ status }: { status: ShipmentStatus }) {
  const m = statusMeta[status]
  return (
    <Badge tone={m.tone} dot pulse={m.pulse}>
      {m.label}
    </Badge>
  )
}

export function StepIcon({ status, className }: { status: StepStatus; className?: string }) {
  const c = cx('size-5', className)
  switch (status) {
    case 'ok':
      return <CheckCircle2 className={cx(c, 'text-emerald-500')} />
    case 'failed':
      return <AlertCircle className={cx(c, 'text-rose-500')} />
    case 'running':
      return <Loader2 className={cx(c, 'animate-spin text-brand-500')} />
    case 'skipped':
      return <MinusCircle className={cx(c, 'text-slate-300')} />
    default:
      return <CircleDashed className={cx(c, 'text-slate-300')} />
  }
}

/* ------------------------------ Modal ------------------------------ */

/** Centered dialog on desktop, bottom sheet on mobile. */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="animate-fade-in absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'animate-slide-up pb-safe relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-white shadow-xl sm:rounded-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="-mr-2 rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="დახურვა">
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmModal({ open, title, message, confirmLabel = 'წაშლა', onConfirm, onClose, busy }: { open: boolean; title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            გაუქმება
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-600">{message}</div>
    </Modal>
  )
}

/* ------------------------------ Misc ------------------------------ */

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">{icon}</div>
      <p className="font-medium text-slate-800">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-slate-500">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Stat({ label, value, sub, icon, accent = 'bg-brand-50 text-brand-600' }: { label: string; value: ReactNode; sub?: ReactNode; icon: ReactNode; accent?: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide break-words text-slate-500">{label}</p>
          <p className="mt-1.5 text-xl font-semibold whitespace-nowrap tabular-nums tracking-tight text-slate-900 sm:text-2xl">{value}</p>
          {sub && <p className="mt-0.5 text-xs leading-snug text-slate-500">{sub}</p>}
        </div>
        <div className={cx('hidden size-10 shrink-0 place-items-center rounded-xl sm:grid', accent)}>{icon}</div>
      </div>
    </Card>
  )
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[11.5px] leading-relaxed text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function Avatar({ text, className }: { text: string; className?: string }) {
  return <span className={cx('grid size-9 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-semibold uppercase text-brand-700', className)}>{text}</span>
}
