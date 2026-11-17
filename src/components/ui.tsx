import { AlertCircle, CheckCircle2, CircleDashed, Loader2, MinusCircle, X } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../lib/util'
import { inputCls, invalidCls } from './fieldStyles'
import { CodeView } from './codeView'
import type { ShipmentStatus, StepStatus } from '../types'

/* ----------------------------- Button ----------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:brightness-110 disabled:opacity-40',
  secondary: 'bg-fill text-brand-600 hover:bg-slate-500/20 disabled:opacity-40',
  ghost: 'text-brand-600 hover:bg-fill disabled:opacity-40',
  danger: 'bg-rose-600 text-white hover:brightness-110 disabled:opacity-40',
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
        'pressable inline-flex items-center justify-center gap-1.5 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed',
        size === 'sm' && 'h-8 rounded-full px-3.5 text-[13px]',
        size === 'md' && 'h-10 rounded-[10px] px-4 text-[15px]',
        size === 'lg' && 'h-[50px] rounded-[14px] px-5 text-[17px]',
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
  return <div className={cx('rounded-xl bg-surface', className)}>{children}</div>
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[30px] leading-tight font-bold tracking-[-0.02em] text-slate-900 sm:text-[34px]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[15px] text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}

/* ------------------------------ Form ------------------------------ */

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 ml-1 block text-[13px] text-slate-500">{label}</span>
      {children}
      {error ? <span className="mt-1 ml-1 block text-xs text-rose-600">{error}</span> : hint ? <span className="mt-1 ml-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  )
}

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} className={cx(inputCls, invalid && invalidCls, className)} />
}

export { DatePicker, Select } from './pickers'

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-3 text-left text-[15px] text-slate-900">
      {label}
      <span className={cx('relative inline-flex h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-emerald-500' : 'bg-fill ring-1 ring-inset ring-slate-500/10')}>
        <span
          className={cx('absolute top-[2px] size-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_3px_1px_rgba(0,0,0,0.06)] transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]', checked ? 'translate-x-[22px]' : 'translate-x-[2px]')}
        />
      </span>
    </button>
  )
}

/* ----------------------------- Badges ----------------------------- */

const tone = {
  gray: 'bg-fill text-slate-600',
  blue: 'bg-brand-100 text-brand-700',
  amber: 'bg-amber-100 text-amber-700',
  green: 'bg-emerald-100 text-emerald-700',
  red: 'bg-rose-100 text-rose-700',
  violet: 'bg-violet-100 text-violet-700',
}
export type Tone = keyof typeof tone

export function Badge({ tone: t = 'gray', children, dot, pulse }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[3px] text-xs font-semibold', tone[t])}>
      {dot && <span className={cx('size-1.5 rounded-full bg-current', pulse && 'animate-pulse')} />}
      {children}
    </span>
  )
}

export const statusMeta: Record<ShipmentStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  uploading: { label: 'იტვირთება', tone: 'blue', pulse: true },
  rs_failed: { label: 'RS.ge შეცდომა', tone: 'red' },
  uploaded: { label: 'ატვირთულია', tone: 'green' },
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
      return <MinusCircle className={cx(c, 'text-slate-400')} />
    default:
      return <CircleDashed className={cx(c, 'text-slate-400')} />
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
      <div className="animate-fade-in absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'animate-sheet-up sm:animate-pop-in pb-safe relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[14px] bg-canvas shadow-2xl sm:rounded-[14px] sm:bg-surface',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="mx-auto mt-1.5 h-[5px] w-9 rounded-full bg-slate-400/50 sm:hidden" />
        <div className="relative flex items-center justify-center px-14 pt-3 pb-3 sm:pt-4">
          <h2 className="truncate text-[17px] font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="pressable absolute right-4 grid size-[30px] place-items-center rounded-full bg-fill text-slate-500" aria-label="დახურვა">
            <X className="size-4" strokeWidth={2.5} />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-4 sm:px-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-4 pt-1 pb-4 sm:px-5 [&>*]:flex-1 sm:[&>*]:flex-none">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmModal({ open, title, message, confirmLabel = 'წაშლა', onConfirm, onClose, busy, disabled }: { open: boolean; title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onClose: () => void; busy?: boolean; disabled?: boolean }) {
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
          <Button variant="danger" onClick={onConfirm} loading={busy} disabled={disabled}>
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
    <div className="animate-fade-in flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 text-slate-400 [&>svg]:size-11 [&>svg]:stroke-[1.5]">{icon}</div>
      <p className="text-[17px] font-semibold text-slate-900">{title}</p>
      {text && <p className="mt-1 max-w-sm text-[15px] text-slate-500">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Widget-style stat tile with a Settings-style solid icon square. */
export function Stat({ label, value, sub, icon, accent = 'bg-brand-500' }: { label: string; value: ReactNode; sub?: ReactNode; icon: ReactNode; accent?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span className={cx('grid size-7 shrink-0 place-items-center rounded-[7px] text-white [&>svg]:size-4', accent)}>{icon}</span>
        <p className="min-w-0 truncate text-[13px] font-semibold text-slate-500">{label}</p>
      </div>
      <p className="mt-3 text-[28px] leading-none font-bold whitespace-nowrap tabular-nums tracking-tight text-slate-900">{value}</p>
      {sub && <p className="mt-1.5 text-[13px] leading-snug text-slate-500">{sub}</p>}
    </Card>
  )
}

export function JsonBlock({ value }: { value: unknown }) {
  return <CodeView value={value} />
}

/** Contacts-style monogram. */
export function Avatar({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cx('grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#a5abb8] to-[#858994] text-sm font-semibold uppercase text-white', className)}>{text}</span>
  )
}

/** iOS segmented control. */
export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cx('inline-flex rounded-[9px] bg-fill p-[2px]', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 flex-1 rounded-[7px] px-3 text-[13px] whitespace-nowrap transition-all duration-200',
            value === o.value ? 'bg-white font-semibold text-slate-900 shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-slate-400' : 'font-medium text-slate-600',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
