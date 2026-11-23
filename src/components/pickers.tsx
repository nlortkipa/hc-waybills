/*
 * macOS-style replacements for native form popups:
 *  - Select: a pop-up button that opens a translucent menu (checkmark on the
 *    current item, accent highlight on hover, blink-on-choose).
 *  - DatePicker: a date field that opens a mini calendar popover.
 * Focus stays on the trigger; the keyboard drives the open popup from there.
 */
import { CalendarDays, Check, ChevronLeft, ChevronRight, ChevronsUpDown, Search, X } from 'lucide-react'
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
import { bareCls, inputCls, invalidCls } from './fieldStyles'

/* --------------------------- Popover plumbing --------------------------- */

/** Fixed-position placement under (or, if cramped, above) the anchor. */
/**
 * `content`: re-placed when it changes (e.g. a search filtering the list), so the panel stays against the anchor.
 * `fixedWidth`: the panel is exactly this wide (or the anchor's width when wider) instead of as wide as its content.
 * `cap`: the panel is never taller than this; it is placed by that height, so it stays against the anchor.
 * `roomBelow`: opens below whenever at least this much room is there (the panel shrinks to fit), as search results do.
 */
function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  matchWidth: boolean,
  content?: unknown,
  fixedWidth?: number,
  cap = Infinity,
  roomBelow = Infinity,
) {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const p = panel.current
      if (!a || !p) return
      const m = 8
      const gap = 6
      const ph = Math.min(p.scrollHeight, cap)
      const below = window.innerHeight - a.bottom - m - gap
      const above = a.top - m - gap
      const up = ph > below && above > below && below < roomBelow
      const maxHeight = Math.min(cap, Math.max(120, up ? above : below))
      const h = Math.min(ph, maxHeight)
      const maxWidth = window.innerWidth - 2 * m
      const w = Math.min(fixedWidth ? Math.max(matchWidth ? a.width : 0, fixedWidth) : Math.max(matchWidth ? a.width : 0, p.offsetWidth), maxWidth)
      const left = Math.max(m, Math.min(a.left, window.innerWidth - w - m))
      setStyle({
        position: 'fixed',
        top: up ? a.top - gap - h : a.bottom + gap,
        left,
        minWidth: matchWidth ? Math.min(a.width, maxWidth) : undefined,
        width: fixedWidth ? w : undefined,
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
  }, [open, anchor, panel, matchWidth, content, fixedWidth, cap, roomBelow])

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

/** Phone-sized screens, where long menus open as a bottom sheet instead. */
function useNarrow() {
  const q = '(max-width: 639.98px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

const panelBase = 'menu-material animate-menu-in fixed z-[70] rounded-[10px] outline-none'
const panelCls = `${panelBase} overflow-y-auto overscroll-contain`

/* -------------------------------- Select -------------------------------- */

/** `label`: what the menu row shows; `short`: what the closed button shows; `text`: what search and type-ahead match. */
type Opt = { value: string; label: ReactNode; short: ReactNode; text: string; disabled?: boolean }

/** Plain text of a node; separate elements are kept apart by a space so search can't match across them. */
function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((n) => (typeof n === 'string' || typeof n === 'number' ? String(n) : isValidElement(n) ? ` ${textOf((n.props as { children?: ReactNode }).children)} ` : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectOptions(children: ReactNode): Opt[] {
  const out: Opt[] = []
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const el = c as ReactElement<{ value?: string | number; label?: string; disabled?: boolean; children?: ReactNode; 'data-search'?: string }>
    if (el.type === 'option') {
      const own = textOf(el.props.children)
      const { label } = el.props
      // Search also matches the button text and any extra words the option lists (content built from components has no text of its own).
      const text = [label, el.props['data-search'], own].filter(Boolean).join(' ')
      out.push({ value: String(el.props.value ?? own), label: el.props.children, short: label ?? el.props.children, text, disabled: el.props.disabled })
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
  /**
   * `<option>` elements, as with a native select. An option's `label` (text) is shown on the closed button instead of its
   * content; `data-search` adds words the search matches.
   */
  children?: ReactNode
  invalid?: boolean
  disabled?: boolean
  className?: string
  id?: string
  'aria-label'?: string
  /** Long lists: the open menu starts with a search field that filters the options by their text. */
  searchable?: boolean
  /** Shows only this icon as a small square button (e.g. a lookup next to a field) instead of the field-like button. */
  icon?: ReactNode
  title?: string
  /**
   * Options laid out by the caller (icon, title, subtitle…): taller list rows with the checkmark at the trailing edge.
   * Inside an option, `group-data-hi:` styles apply while its row is highlighted (white on the accent).
   */
  rich?: boolean
  /** With `rich`: every option is its own tinted card, spaced apart, for options several lines tall (a route and its goods). */
  cards?: boolean
  /** Inside a compound field (`compoundCls`): no fill or focus ring of its own. */
  bare?: boolean
  /** Shown at the top of the open menu, above the options (e.g. what they all have in common). */
  header?: ReactNode
  /** Title of the bottom sheet a `rich` Select opens as on a phone; the placeholder when missing. */
  sheetTitle?: string
}

export function Select({ value, onChange, placeholder, children, invalid, disabled, className, id, 'aria-label': ariaLabel, searchable, icon, title, rich, cards, bare, header, sheetTitle }: SelectProps) {
  const all = collectOptions(children)
  const [query, setQuery] = useState('')
  const q = searchable ? query.trim().toLowerCase() : ''
  const opts = q ? all.filter((o) => o.text.toLowerCase().includes(q)) : all
  const cur = value == null ? '' : String(value)
  const selected = all.find((o) => o.value === cur)

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [flash, setFlash] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const typed = useRef({ buf: '', t: 0 })
  // Rich rows wrap their text: the menu is as wide as the field (a small icon button gets a usable width), not as its longest row.
  const style = useAnchoredPosition(open, btn, panel, !icon, query, rich ? 352 : undefined)

  const close = () => {
    setOpen(false)
    setFlash(null)
    // Focus moved into the search field while open: give it back to the button.
    if (searchable && panel.current?.contains(document.activeElement)) btn.current?.focus()
  }
  useDismiss(open, [btn, panel], close)

  // On a phone, rich options (several lines each) open as an iOS bottom sheet: the page behind stays put.
  const narrow = useNarrow()
  const asSheet = !!rich && narrow && !icon
  useEffect(() => {
    if (!open || !asSheet) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open, asSheet])

  const show = () => {
    if (disabled) return
    setQuery('')
    setActive(all.findIndex((o) => o.value === cur && !o.disabled))
    setOpen(true)
  }

  const choose = (o: Opt) => {
    if (o.disabled || flash != null) return
    if (o.value !== cur) onChange?.({ target: { value: o.value } })
    setFlash(o.value)
    window.setTimeout(close, 170)
  }

  // Into the search field once the menu is placed: while it is still hidden for measuring, focus() is ignored.
  const placed = style.visibility !== 'hidden'
  useEffect(() => {
    // Not in a sheet: the keyboard would cover the options before they are even seen.
    if (open && placed && !asSheet) search.current?.focus()
  }, [open, placed, asSheet])

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
    // In the search field, letters are typed into it.
    if (searchable) return
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
        title={title}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={
          icon
            ? cx('grid size-8 place-items-center rounded-lg text-slate-500 hover:bg-brand-50 hover:text-brand-600 disabled:opacity-40', open && 'bg-brand-50 text-brand-600', className)
            : cx(bare ? bareCls : inputCls, 'flex cursor-default items-center gap-2 pr-[9px] text-left', rich && 'h-auto min-h-11 py-2 sm:h-auto sm:min-h-9 sm:py-1.5', !bare && open && 'ring-2 ring-brand-500/50!', !bare && invalid && invalidCls, className)
        }
      >
        {icon ?? (
          <>
            <span className={cx('min-w-0 flex-1', rich ? 'line-clamp-2 leading-snug [overflow-wrap:anywhere]' : 'truncate', !selected && 'text-slate-400')}>{selected ? selected.short : placeholder}</span>
            {/* A quiet chevron: in a dense form, the accent is kept for focus and the primary action. */}
            <ChevronsUpDown className="size-4 shrink-0 text-slate-500" strokeWidth={2} />
          </>
        )}
      </button>

      {open &&
        asSheet &&
        createPortal(
          <div ref={panel} className="fixed inset-0 z-[70]">
            <div className="animate-fade-in absolute inset-0 bg-black/40" onClick={close} />
            <div className="animate-sheet-up absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-[14px] bg-canvas pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_30px_rgba(0,0,0,0.18)]">
              <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-full bg-slate-400/50" />
              <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-2.5 pb-3">
                <h2 className="min-w-0 truncate text-[17px] font-semibold text-slate-900">{sheetTitle ?? placeholder}</h2>
                <button type="button" onClick={close} className="pressable grid size-[30px] shrink-0 place-items-center rounded-full bg-fill text-slate-500" aria-label="დახურვა">
                  <X className="size-4" strokeWidth={2.5} />
                </button>
              </div>
              {searchable && all.length > 1 && (
                <label className="relative mx-4 mb-3 block shrink-0">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" strokeWidth={2.25} />
                  <input
                    ref={search}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="ძებნა"
                    aria-label="ძებნა"
                    className="h-9 w-full rounded-[10px] bg-fill pr-3 pl-8 text-[16px] text-slate-900 outline-none placeholder:text-slate-400"
                  />
                </label>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
                {opts.length === 0 ? (
                  <p className="py-10 text-center text-[15px] text-slate-400">{q ? 'ვერაფერი მოიძებნა' : 'ვარიანტები არ არის'}</p>
                ) : (
                  <div id={listId} role="listbox" aria-label={sheetTitle ?? placeholder} className={cards ? 'space-y-2' : 'overflow-hidden rounded-xl bg-surface'}>
                    {opts.map((o, i) => {
                      const on = o.value === (flash ?? cur)
                      return (
                        <div
                          key={o.value + ':' + i}
                          role="option"
                          aria-selected={on}
                          aria-disabled={o.disabled || undefined}
                          onClick={() => choose(o)}
                          className={cx(
                            'relative flex cursor-default items-center gap-3 py-3 pr-3.5 pl-4 text-[16px] leading-snug transition-colors select-none active:bg-fill',
                            // Cards stand apart; plain rows get an inset hairline between them, as in iOS grouped lists.
                            cards ? 'rounded-xl bg-surface' : i > 0 && 'before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:origin-top before:scale-y-50 before:bg-separator',
                            o.disabled ? 'text-slate-400' : 'text-slate-900',
                            flash === o.value && 'bg-fill',
                          )}
                        >
                          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o.label}</span>
                          <Check className={cx('size-[18px] shrink-0 text-brand-500', !on && 'invisible')} strokeWidth={2.75} />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {open &&
        !asSheet &&
        createPortal(
          <div
            ref={panel}
            id={listId}
            role="listbox"
            style={style}
            // With a search field the panel doesn't scroll: the field stays on top and only the options scroll.
            // A small icon button doesn't set the menu's width: it gets a usable one of its own.
            className={cx(searchable ? `${panelBase} flex flex-col overflow-hidden` : panelCls, 'p-[5px]', !!icon && !rich && 'w-[22rem]')}
            onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}
            onMouseLeave={() => flash == null && setActive(-1)}
          >
            {searchable && (
              <label className="relative mb-1 block shrink-0">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-slate-400" strokeWidth={2.25} />
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActive(e.target.value.trim() ? 0 : -1)
                  }}
                  onKeyDown={onKeyDown}
                  placeholder="ძებნა"
                  aria-label="ძებნა"
                  className="h-9 w-full rounded-[6px] bg-fill pr-2.5 pl-7 text-[15px] text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500/40 sm:h-7 sm:text-[13px]"
                />
              </label>
            )}
            {header && <div className="mx-1.5 mb-1 shrink-0 border-b border-separator pt-0.5 pb-1.5">{header}</div>}
            <div className={searchable ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : 'contents'}>
              {opts.length === 0 && <div className="px-3 py-1.5 text-[15px] text-slate-400 sm:text-[13px]">{q ? 'ვერაფერი მოიძებნა' : 'ვარიანტები არ არის'}</div>}
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
                    data-hi={hi || undefined}
                    onMouseMove={() => !o.disabled && flash == null && active !== i && setActive(i)}
                    onClick={() => choose(o)}
                    className={cx(
                      'group flex cursor-default items-center rounded-[5px] text-[15px] leading-snug select-none',
                      rich
                        ? 'min-h-14 gap-2.5 rounded-[7px] py-2 pr-2.5 pl-2 sm:min-h-11 sm:py-2 sm:text-[13px]'
                        : 'min-h-9 gap-1 py-1.5 pr-3 pl-1 sm:min-h-[24px] sm:py-0 sm:text-[13px] sm:whitespace-nowrap',
                      cards && 'mb-1 last:mb-0',
                      o.disabled ? 'text-slate-400' : hi ? 'bg-brand-500 text-white' : 'text-slate-900',
                      cards && !hi && 'bg-fill',
                      flash === o.value && 'animate-menu-blink',
                    )}
                  >
                    {!rich && <Check className={cx('size-3.5 shrink-0', !on && 'invisible')} strokeWidth={3} />}
                    <span className={cx('min-w-0 [overflow-wrap:anywhere]', rich ? 'flex-1' : 'sm:truncate')}>{o.label}</span>
                    {rich && <Check className={cx('size-4 shrink-0', hi ? 'text-white' : 'text-brand-500', !on && 'invisible')} strokeWidth={2.75} />}
                  </div>
                )
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/**
 * The content of a `rich` Select option: a tinted icon tile (when given), a title and a gray subtitle.
 * Every picker of records (routes, carriers, drivers, trucks, products…) lays its rows out with it.
 */
export function OptionRow({ icon, title, sub }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      {icon && (
        <span className="grid size-9 shrink-0 place-items-center rounded-[8px] bg-brand-500/12 text-brand-600 group-data-hi:bg-white/20 group-data-hi:text-white sm:size-8 sm:rounded-[7px] [&>svg]:size-[17px] sm:[&>svg]:size-4">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">{title || '—'}</span>
        {sub && (
          <span className="flex min-w-0 gap-1.5 text-[13px] text-slate-500 group-data-hi:text-white/80 sm:text-[11.5px]">
            {typeof sub === 'string' ? <span className="min-w-0 truncate">{sub}</span> : sub}
          </span>
        )}
      </span>
    </span>
  )
}

/* ------------------------------ MultiSelect ----------------------------- */

export type MultiOpt = { value: string; label: string; sub?: string }

/**
 * Picks several records out of a long list, like a token field: the chosen ones sit in the field as tokens (✕ removes
 * one), and typing in the field filters a menu of rich rows that toggle without closing it, so several can be ticked in
 * a row. A row's icon tile turns into a filled checkmark while it is chosen. On a phone the menu is a bottom sheet.
 * Keyboard: ↑/↓ move, Enter toggles, Backspace on an empty search removes the last token, Escape closes.
 * Not for use inside a <label>: a click on the field would be forwarded to the first token's ✕.
 */
export function MultiSelect({
  value,
  onChange,
  options,
  placeholder = 'აირჩიე',
  icon,
  sheetTitle,
  invalid,
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  value: string[]
  onChange: (v: string[]) => void
  options: MultiOpt[]
  placeholder?: string
  /** Shown in each row's tile while it isn't chosen. */
  icon?: ReactNode
  /** Title of the bottom sheet on a phone; the aria-label when missing. */
  sheetTitle?: string
  invalid?: boolean
  disabled?: boolean
  id?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const narrow = useNarrow()

  const q = query.trim().toLowerCase()
  const opts = q ? options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q)) : options
  const chosen = value.map((v) => options.find((o) => o.value === v)).filter((o): o is MultiOpt => !!o)
  // As wide as the field (at least 320px), at most 340px tall, below the field unless it's cramped there, and re-placed
  // as the field grows a row or the search narrows the list.
  const style = useAnchoredPosition(open && !narrow, box, panel, true, `${query}|${value.length}`, 320, 340, 240)

  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(-1)
  }
  useDismiss(open && !narrow, [box, panel], close)

  useEffect(() => {
    if (!open || !narrow) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open, narrow])

  const show = () => {
    if (disabled || open) return
    setOpen(true)
    setActive(-1)
  }

  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
    // In the field, a search typed to find one record is done once it's picked: the full list comes back.
    if (query && !narrow) {
      setQuery('')
      setActive(-1)
    }
    if (!narrow) input.current?.focus()
  }

  useEffect(() => {
    if (open && active >= 0) panel.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const key = e.key
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (key === 'Backspace' && !query && value.length) return onChange(value.slice(0, -1))
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter') {
        handled()
        show()
      }
      return
    }
    if (key === 'Escape') return handled(), close()
    if (key === 'Tab') return close()
    if (key === 'ArrowDown') return handled(), setActive((i) => Math.min(i + 1, opts.length - 1))
    if (key === 'ArrowUp') return handled(), setActive((i) => (i <= 0 ? opts.length - 1 : i - 1))
    if (key === 'Enter') {
      handled()
      if (active >= 0 && opts[active]) toggle(opts[active].value)
    }
  }

  /** The tile at a row's leading edge: the record's icon, or a filled checkmark while it is chosen. */
  const tile = (on: boolean) => (
    <span
      className={cx(
        'grid size-9 shrink-0 place-items-center rounded-[8px] transition-colors sm:size-8 sm:rounded-[7px] [&>svg]:size-[17px] sm:[&>svg]:size-4',
        on ? 'bg-brand-500 text-white group-data-hi:bg-white group-data-hi:text-brand-600' : 'bg-brand-500/12 text-brand-600 group-data-hi:bg-white/20 group-data-hi:text-white',
      )}
    >
      {on ? <Check strokeWidth={3} /> : icon}
    </span>
  )
  const text = (o: MultiOpt) => (
    <span className="min-w-0 flex-1">
      <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">{o.label}</span>
      {o.sub && <span className="block truncate text-[13px] text-slate-500 group-data-hi:text-white/80 sm:text-[11.5px]">{o.sub}</span>}
    </span>
  )
  const empty = <p className="px-3 py-6 text-center text-[15px] text-slate-400 sm:py-3 sm:text-[13px]">{q ? 'ვერაფერი მოიძებნა' : 'ვარიანტები არ არის'}</p>

  return (
    <>
      <div
        ref={box}
        onMouseDown={(e) => {
          if (disabled) return
          // Clicks on the field (not on a token's ✕) go to the search box and open or close the menu.
          if ((e.target as HTMLElement).closest('button')) return
          if (e.target !== input.current) e.preventDefault()
          if (!narrow) input.current?.focus()
          if (open && e.target !== input.current) close()
          else show()
        }}
        className={cx(
          inputCls,
          'flex h-auto min-h-11 cursor-text items-start gap-1 py-[6px] pr-[9px] pl-[6px] focus-within:ring-2 focus-within:ring-brand-500/50 sm:h-auto sm:min-h-9 sm:py-1 sm:pl-1',
          open && 'ring-2 ring-brand-500/50!',
          invalid && invalidCls,
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {chosen.map((o) => (
            <span
              key={o.value}
              className="animate-menu-in flex h-8 max-w-full items-center gap-0.5 rounded-[6px] bg-brand-500/15 pr-0.5 pl-2.5 text-[15px] text-slate-900 sm:h-7 sm:rounded-[5px] sm:pl-2 sm:text-[13px]"
            >
              <span className="min-w-0 truncate">{o.label}</span>
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                onClick={() => onChange(value.filter((x) => x !== o.value))}
                className="grid size-7 shrink-0 place-items-center rounded-[5px] text-slate-500 transition-colors hover:bg-brand-500/20 hover:text-slate-900 sm:size-6 sm:rounded-[4px]"
                aria-label={`${o.label} — მოხსნა`}
              >
                <X className="size-3.5 sm:size-3" strokeWidth={2.5} />
              </button>
            </span>
          ))}
          <input
            ref={input}
            id={id}
            role="combobox"
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            // On a phone the sheet has its own search field: this one only opens it, without raising the keyboard.
            readOnly={narrow}
            disabled={disabled}
            value={narrow ? '' : query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(e.target.value.trim() ? 0 : -1)
              show()
            }}
            onKeyDown={onKeyDown}
            placeholder={chosen.length ? (narrow ? '' : 'ძებნა…') : placeholder}
            className="h-8 min-w-[8rem] flex-1 bg-transparent px-1.5 text-[16px] text-slate-900 outline-none placeholder:text-slate-400 sm:h-7 sm:text-[14px]"
          />
        </div>
        <span className="grid h-8 shrink-0 place-items-center sm:h-7">
          <ChevronsUpDown className="size-4 text-slate-500" strokeWidth={2} />
        </span>
      </div>

      {open &&
        !narrow &&
        createPortal(
          <div
            ref={panel}
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            style={style}
            className={cx(panelBase, 'flex flex-col overflow-hidden')}
            onMouseDown={(e) => e.preventDefault()}
            onMouseLeave={() => setActive(-1)}
          >
            {value.length > 0 && (
              <div className="mx-[5px] flex shrink-0 items-center justify-between border-b border-separator py-1.5 pr-1.5 pl-2 text-[12px] text-slate-500">
                <span>არჩეულია {value.length}</span>
                <button type="button" onClick={() => onChange([])} className="rounded-[4px] px-1 font-medium text-brand-600 hover:bg-brand-500/10">
                  ყველას მოხსნა
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-[5px]">
              {opts.length === 0 && empty}
              {opts.map((o, i) => {
                const on = value.includes(o.value)
                const hi = i === active
                return (
                  <div
                    key={o.value}
                    id={`${listId}-${i}`}
                    data-i={i}
                    data-hi={hi || undefined}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => active !== i && setActive(i)}
                    onClick={() => toggle(o.value)}
                    className={cx(
                      'group flex min-h-12 cursor-default items-center gap-2.5 rounded-[7px] py-1.5 pr-2.5 pl-1.5 text-[15px] leading-snug select-none sm:min-h-11 sm:text-[13px]',
                      hi ? 'bg-brand-500 text-white' : 'text-slate-900',
                    )}
                  >
                    {tile(on)}
                    {text(o)}
                  </div>
                )
              })}
            </div>
          </div>,
          document.body,
        )}

      {open &&
        narrow &&
        createPortal(
          <div ref={panel} className="fixed inset-0 z-[70]">
            <div className="animate-fade-in absolute inset-0 bg-black/40" onClick={close} />
            <div className="animate-sheet-up absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-[14px] bg-canvas pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_30px_rgba(0,0,0,0.18)]">
              <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-full bg-slate-400/50" />
              <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-2.5 pb-3">
                <h2 className="min-w-0 truncate text-[17px] font-semibold text-slate-900">
                  {sheetTitle ?? ariaLabel}
                  {value.length > 0 && <span className="ml-1.5 font-normal text-slate-500">{value.length}</span>}
                </h2>
                <button type="button" onClick={close} className="pressable shrink-0 text-[17px] font-semibold text-brand-600">
                  მზადაა
                </button>
              </div>
              {options.length > 1 && (
                <label className="relative mx-4 mb-3 block shrink-0">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" strokeWidth={2.25} />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="ძებნა"
                    aria-label="ძებნა"
                    className="h-9 w-full rounded-[10px] bg-fill pr-3 pl-8 text-[16px] text-slate-900 outline-none placeholder:text-slate-400"
                  />
                </label>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
                {opts.length === 0 ? (
                  empty
                ) : (
                  <div id={listId} role="listbox" aria-multiselectable="true" aria-label={sheetTitle ?? ariaLabel} className="overflow-hidden rounded-xl bg-surface">
                    {opts.map((o, i) => {
                      const on = value.includes(o.value)
                      return (
                        <div
                          key={o.value}
                          role="option"
                          aria-selected={on}
                          onClick={() => toggle(o.value)}
                          className={cx(
                            'group relative flex cursor-default items-center gap-3 py-2.5 pr-3.5 pl-3 text-[16px] leading-snug text-slate-900 transition-colors select-none active:bg-fill',
                            i > 0 && 'before:absolute before:top-0 before:right-0 before:left-[60px] before:h-px before:origin-top before:scale-y-50 before:bg-separator',
                          )}
                        >
                          {tile(on)}
                          {text(o)}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
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
