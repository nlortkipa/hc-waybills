/*
 * macOS-style replacements for native form popups:
 *  - Select: a pop-up button that opens a translucent menu (checkmark on the
 *    current item, accent highlight on hover, blink-on-choose).
 *  - DatePicker: a date field that opens a mini calendar popover.
 * Focus stays on the trigger; the keyboard drives the open popup from there.
 */
import { CalendarDays, Check, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cx, formatDay, tbilisiDay } from '../lib/util'
import { inputCls, invalidCls } from './fieldStyles'

/* --------------------------- Popover plumbing --------------------------- */

/** Fixed-position placement under (or, if cramped, above) the anchor. */
function useAnchoredPosition(open: boolean, anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, matchWidth: boolean) {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const p = panel.current
      if (!a || !p) return
      const m = 8
      const gap = 6
      const ph = p.scrollHeight
      const below = window.innerHeight - a.bottom - m - gap
      const above = a.top - m - gap
      const up = ph > below && above > below
      const maxHeight = Math.max(120, up ? above : below)
      const h = Math.min(ph, maxHeight)
      const maxWidth = window.innerWidth - 2 * m
      const w = Math.min(Math.max(matchWidth ? a.width : 0, p.offsetWidth), maxWidth)
      const left = Math.max(m, Math.min(a.left, window.innerWidth - w - m))
      setStyle({
        position: 'fixed',
        top: up ? a.top - gap - h : a.bottom + gap,
        left,
        minWidth: matchWidth ? Math.min(a.width, maxWidth) : undefined,
        maxWidth,
        maxHeight,
        transformOrigin: up ? 'bottom center' : 'top center',
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, panel, matchWidth])

  return style
}

function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], onDismiss: () => void) {
  const cb = useRef(onDismiss)
  cb.current = onDismiss
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (refs.some((r) => r.current?.contains(t))) return
      cb.current()
    }
    const onBlur = () => cb.current()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

const panelCls = 'menu-material animate-menu-in fixed z-[70] overflow-y-auto overscroll-contain rounded-[10px] outline-none'

/* -------------------------------- Select -------------------------------- */

type Opt = { value: string; label: ReactNode; text: string; disabled?: boolean }

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((n) => (typeof n === 'string' || typeof n === 'number' ? String(n) : isValidElement(n) ? textOf((n.props as { children?: ReactNode }).children) : ''))
    .join('')
}

function collectOptions(children: ReactNode): Opt[] {
  const out: Opt[] = []
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const el = c as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>
    if (el.type === 'option') {
      const text = textOf(el.props.children)
      out.push({ value: String(el.props.value ?? text), label: el.props.children, text, disabled: el.props.disabled })
    } else if (el.type === Fragment) {
      out.push(...collectOptions(el.props.children))
    }
  })
  return out
}

export type SelectProps = {
  value?: string | number
  /** Event-shaped so it is a drop-in for a native <select> handler. */
  onChange?: (e: { target: { value: string } }) => void
  /** Shown (dimmed) when no option matches `value`. */
  placeholder?: string
  /** `<option>` elements, as with a native select. */
  children?: ReactNode
  invalid?: boolean
  disabled?: boolean
  className?: string
  id?: string
  'aria-label'?: string
}

export function Select({ value, onChange, placeholder, children, invalid, disabled, className, id, 'aria-label': ariaLabel }: SelectProps) {
  const opts = collectOptions(children)
  const cur = value == null ? '' : String(value)
  const selected = opts.find((o) => o.value === cur)

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [flash, setFlash] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const listId = useId()
  const typed = useRef({ buf: '', t: 0 })
  const style = useAnchoredPosition(open, btn, panel, true)

  const close = () => {
    setOpen(false)
    setFlash(null)
  }
  useDismiss(open, [btn, panel], close)

  const show = () => {
    if (disabled) return
    setActive(opts.findIndex((o) => o.value === cur && !o.disabled))
    setOpen(true)
  }

  const choose = (o: Opt) => {
    if (o.disabled || flash != null) return
    if (o.value !== cur) onChange?.({ target: { value: o.value } })
    setFlash(o.value)
    window.setTimeout(close, 170)
  }

  // Keep the keyboard-highlighted row visible.
  useEffect(() => {
    if (open && active >= 0) panel.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < opts.length; i += dir) if (!opts[i].disabled) return i
    return from
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) {
        e.preventDefault()
        show()
      }
      return
    }
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (key === 'Escape') return handled(), close()
    if (key === 'Tab') return close()
    if (key === 'ArrowDown') return handled(), setActive((i) => step(i, 1))
    if (key === 'ArrowUp') return handled(), setActive((i) => (i < 0 ? step(opts.length, -1) : step(i, -1)))
    if (key === 'Home') return handled(), setActive(step(-1, 1))
    if (key === 'End') return handled(), setActive(step(opts.length, -1))
    if (key === 'Enter' || (key === ' ' && !typed.current.buf)) {
      handled()
      if (active >= 0) choose(opts[active])
      return
    }
    if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      handled()
      const now = Date.now()
      const t = typed.current
      t.buf = (now - t.t > 700 ? '' : t.buf) + key.toLowerCase()
      t.t = now
      window.setTimeout(() => Date.now() - t.t >= 700 && (t.buf = ''), 720)
      const i = opts.findIndex((o) => !o.disabled && o.text.trim().toLowerCase().startsWith(t.buf))
      if (i >= 0) setActive(i)
    }
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        id={id}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={cx(inputCls, 'flex cursor-default items-center gap-2 pr-[9px] text-left', open && 'ring-2 ring-brand-500/50', invalid && invalidCls, className)}
      >
        <span className={cx('min-w-0 flex-1 truncate', !selected && 'text-slate-400')}>{selected ? selected.label : placeholder}</span>
        <span className="grid size-[22px] shrink-0 place-items-center rounded-[6px] bg-brand-500 text-white shadow-[0_0.5px_1px_rgba(0,0,0,0.2),inset_0_0.5px_0_rgba(255,255,255,0.25)]">
          <ChevronsUpDown className="size-3.5" strokeWidth={2.5} />
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panel}
            id={listId}
            role="listbox"
            style={style}
            className={cx(panelCls, 'p-[5px]')}
            onMouseDown={(e) => e.preventDefault()}
            onMouseLeave={() => flash == null && setActive(-1)}
          >
            {opts.length === 0 && <div className="px-3 py-1.5 text-[15px] text-slate-400 sm:text-[13px]">ვარიანტები არ არის</div>}
            {opts.map((o, i) => {
              const on = o.value === cur
              const hi = !o.disabled && (flash != null ? flash === o.value : i === active)
              return (
                <div
                  key={o.value + ':' + i}
                  id={`${listId}-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={on}
                  aria-disabled={o.disabled || undefined}
                  onMouseMove={() => !o.disabled && flash == null && active !== i && setActive(i)}
                  onClick={() => choose(o)}
                  className={cx(
                    'flex min-h-9 cursor-default items-center gap-1 rounded-[5px] py-1.5 pr-3 pl-1 text-[15px] leading-snug select-none sm:min-h-[24px] sm:py-0 sm:text-[13px] sm:whitespace-nowrap',
                    o.disabled ? 'text-slate-400' : hi ? 'bg-brand-500 text-white' : 'text-slate-900',
                    flash === o.value && 'animate-menu-blink',
                  )}
                >
                  <Check className={cx('size-3.5 shrink-0', !on && 'invisible')} strokeWidth={3} />
                  <span className="min-w-0 [overflow-wrap:anywhere] sm:truncate">{o.label}</span>
                </div>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}

/* ------------------------------ DatePicker ------------------------------ */

const MONTHS_FULL = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი']
const WEEKDAYS = ['ორ', 'სა', 'ოთ', 'ხუ', 'პა', 'შა', 'კვ'] // Monday first

const pad = (n: number) => String(n).padStart(2, '0')
const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number)
  return y && m && d ? new Date(y, m - 1, d) : null
}
const addDays = (k: string, n: number) => {
  const d = fromKey(k)!
  d.setDate(d.getDate() + n)
  return toKey(d)
}
const addMonths = (k: string, n: number) => {
  const d = fromKey(k)!
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
  return toKey(d)
}

export type DatePickerProps = {
  /** `YYYY-MM-DD` */
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  invalid?: boolean
  disabled?: boolean
  className?: string
  id?: string
  placeholder?: string
}

export function DatePicker({ value, onChange, min, max, invalid, disabled, className, id, placeholder = 'აირჩიე თარიღი' }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const today = tbilisiDay()
  const [cursor, setCursor] = useState(value || today)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const style = useAnchoredPosition(open, btn, panel, false)
  const close = () => setOpen(false)
  useDismiss(open, [btn, panel], close)

  const clamp = (k: string) => (min && k < min ? min : max && k > max ? max : k)
  const allowed = (k: string) => !(min && k < min) && !(max && k > max)

  const show = () => {
    if (disabled) return
    setCursor(clamp(value || today))
    setOpen(true)
  }
  const pick = (k: string) => {
    if (!allowed(k)) return
    if (k !== value) onChange(k)
    close()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) {
        e.preventDefault()
        show()
      }
      return
    }
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      PageUp: () => addMonths(cursor, -1),
      PageDown: () => addMonths(cursor, 1),
      t: () => today,
    }
    if (moves[k]) {
      e.preventDefault()
      e.stopPropagation()
      setCursor(clamp(moves[k]()))
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault()
      e.stopPropagation()
      pick(cursor)
    } else if (k === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (k === 'Tab') close()
  }

  // 6-week grid starting on the Monday on/before the 1st of the cursor's month.
  const c = fromKey(cursor) ?? fromKey(tbilisiDay())!
  const first = new Date(c.getFullYear(), c.getMonth(), 1)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return { key: toKey(d), day: d.getDate(), inMonth: d.getMonth() === c.getMonth() }
  })

  const shown = fromKey(value)
  const navBtn = 'pressable grid size-7 place-items-center rounded-[6px] text-slate-600 hover:bg-fill disabled:opacity-30 sm:size-6'

  return (
    <>
      <button
        ref={btn}
        type="button"
        id={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={cx(inputCls, 'flex cursor-default items-center gap-2 pr-2.5 text-left tabular-nums', open && 'ring-2 ring-brand-500/50', invalid && invalidCls, className)}
      >
        <span className={cx('min-w-0 flex-1 truncate', !shown && 'text-slate-400')}>{shown ? `${formatDay(shown)} ${shown.getFullYear()}` : placeholder}</span>
        <CalendarDays className="size-[18px] shrink-0 text-slate-500" strokeWidth={1.75} />
      </button>

      {open &&
        createPortal(
          <div ref={panel} role="dialog" aria-label="კალენდარი" style={style} className={cx(panelCls, 'w-[272px] p-3 sm:w-[236px] sm:p-2.5')} onMouseDown={(e) => e.preventDefault()}>
            <div className="mb-2 flex items-center gap-1 pl-1">
              <p className="flex-1 truncate text-[15px] font-semibold text-slate-900 sm:text-[13px]">
                {MONTHS_FULL[c.getMonth()]} <span className="font-normal text-slate-500 tabular-nums">{c.getFullYear()}</span>
              </p>
              <button type="button" tabIndex={-1} className={navBtn} aria-label="წინა თვე" onClick={() => setCursor(clamp(addMonths(cursor, -1)))} disabled={!!min && toKey(new Date(c.getFullYear(), c.getMonth(), 0)) < min}>
                <ChevronLeft className="size-4" strokeWidth={2.5} />
              </button>
              <button type="button" tabIndex={-1} className={navBtn} aria-label="დღეს" title="დღეს" onClick={() => setCursor(clamp(today))}>
                <span className="size-[7px] rounded-full bg-current" />
              </button>
              <button type="button" tabIndex={-1} className={navBtn} aria-label="შემდეგი თვე" onClick={() => setCursor(clamp(addMonths(cursor, 1)))} disabled={!!max && toKey(new Date(c.getFullYear(), c.getMonth() + 1, 1)) > max}>
                <ChevronRight className="size-4" strokeWidth={2.5} />
              </button>
            </div>
            <div className="grid grid-cols-7 text-center text-[11px] font-medium text-slate-500 sm:text-[10px]">
              {WEEKDAYS.map((w) => (
                <span key={w} className="pb-1">
                  {w}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 place-items-center gap-y-0.5" role="grid">
              {days.map((d) => {
                const sel = d.key === value
                const ok = allowed(d.key)
                const isCursor = d.key === cursor
                return (
                  <button
                    key={d.key}
                    type="button"
                    tabIndex={-1}
                    role="gridcell"
                    aria-selected={sel}
                    disabled={!ok}
                    onClick={() => pick(d.key)}
                    onMouseEnter={() => setCursor(d.key)}
                    className={cx(
                      'grid size-9 cursor-default place-items-center rounded-full text-[15px] tabular-nums transition-colors duration-100 sm:size-[30px] sm:text-[13px]',
                      !ok && 'opacity-30',
                      sel ? 'bg-brand-500 font-semibold text-white' : d.key === today ? 'font-semibold text-brand-600' : d.inMonth ? 'text-slate-900' : 'text-slate-400',
                      !sel && isCursor && ok && 'bg-fill',
                    )}
                  >
                    {d.day}
                  </button>
                )
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
