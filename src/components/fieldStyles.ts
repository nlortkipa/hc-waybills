/** The size and type of text-like form controls: 44pt touch targets on a phone, 36px on a desktop. */
const fieldBox = 'block w-full h-11 sm:h-9 px-3 text-[16px] sm:text-[14px] text-slate-900 placeholder:text-slate-400 disabled:opacity-50'

/** Shared look for text-like form controls (inputs, pop-up buttons, date fields). */
export const inputCls = `${fieldBox} rounded-[10px] sm:rounded-[8px] border-0 bg-fill ring-inset ring-transparent focus:ring-2 focus:ring-brand-500/50 focus:outline-none transition-shadow`

/** A control inside a compound field (see `compoundCls`): no fill or ring of its own. */
export const bareCls = `${fieldBox} border-0 bg-transparent focus:outline-none`

/** Several controls sharing one field, e.g. a quantity and its unit: one fill, one focus ring. */
export const compoundCls =
  'flex items-stretch rounded-[10px] sm:rounded-[8px] bg-fill ring-inset ring-transparent focus-within:ring-2 focus-within:ring-brand-500/50 transition-shadow'

// The color is marked important: otherwise ring-transparent, from the base look, wins.
export const invalidCls = 'ring-2 ring-rose-500/60!'
