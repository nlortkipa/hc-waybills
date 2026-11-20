import { shiftMonths, tbilisiDay } from '../lib/util'
import { DatePicker } from './pickers'

/** FROM – TO days (`YYYY-MM-DD`, both included), up to today. `maxMonths` caps how far apart they can be. */
export function DateRange({ from, to, onFrom, onTo, maxMonths }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void; maxMonths?: number }) {
  const today = tbilisiDay()
  const cls = 'min-w-0 flex-1 sm:w-[9.5rem] sm:flex-none'
  return (
    <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
      <DatePicker value={from} min={maxMonths ? shiftMonths(to, -maxMonths) : undefined} max={to} onChange={onFrom} className={cls} />
      <span className="text-slate-400">–</span>
      <DatePicker value={to} min={from} max={maxMonths ? [today, shiftMonths(from, maxMonths)].sort()[0] : today} onChange={onTo} className={cls} />
    </div>
  )
}
