/**
 * Syntax-highlighted, pretty-printed view of logged request/response payloads.
 * JSON is indented and colored; string values that hold XML (SOAP bodies) or
 * JSON are expanded and formatted in place instead of shown as one escaped line.
 * The XML formatter is a tolerant tokenizer, so truncated bodies still render.
 */
import { useMemo } from 'react'

type Kind = 'key' | 'str' | 'num' | 'kw' | 'punct' | 'tag' | 'attr' | 'aval' | 'text' | 'meta'
type Tok = { t: string; k?: Kind }

const kindCls: Record<Kind, string> = {
  key: 'text-[#6bdfff]',
  str: 'text-[#fc6a5d]',
  num: 'text-[#d9c97c]',
  kw: 'text-[#fc5fa3]',
  punct: 'text-[#8e8e93]',
  tag: 'text-[#5dd8ff]',
  attr: 'text-[#d0a8ff]',
  aval: 'text-[#fc6a5d]',
  text: 'text-[#f2f2f7]',
  meta: 'text-[#8e8e93] italic',
}

const looksXml = (s: string) => /^\s*<[?!a-zA-Z]/.test(s)

function tryJson(s: string): unknown {
  const t = s.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

/* ------------------------------ XML ------------------------------ */

const XML_ITEM = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[?!][\s\S]*?(?:>|$)|<\/?[^<>]*>?|[^<]+/g
const ATTR = /(\s+)([^\s=/>]+)(?:(\s*=\s*)("[^"]*"?|'[^']*'?|[^\s>]+))?/y

function tagTokens(raw: string, out: Tok[]) {
  const m = /^(<\/?)([^\s/>]*)([\s\S]*?)(\/?>)?$/.exec(raw)
  if (!m) return void out.push({ t: raw, k: 'tag' })
  const [, open, name, rest, close] = m
  out.push({ t: open, k: 'punct' }, { t: name, k: 'tag' })
  let i = 0
  while (i < rest.length) {
    ATTR.lastIndex = i
    const a = ATTR.exec(rest)
    if (!a) {
      out.push({ t: rest.slice(i), k: 'text' })
      break
    }
    out.push({ t: a[1] }, { t: a[2], k: 'attr' })
    if (a[3]) out.push({ t: a[3], k: 'punct' }, { t: a[4], k: 'aval' })
    i = ATTR.lastIndex
  }
  if (close) out.push({ t: close, k: 'punct' })
}

function xmlTokens(src: string, pad: string, out: Tok[]) {
  const items = (src.match(XML_ITEM) ?? []).map((s) => (s.startsWith('<') ? s : s.trim())).filter(Boolean)
  const isOpen = (s: string) => /^<[^/?!]/.test(s) && !s.endsWith('/>') && s.endsWith('>')
  const isClose = (s: string) => s.startsWith('</')
  const isText = (s: string) => !s.startsWith('<') || s.startsWith('<![CDATA[')
  const emitText = (s: string) => out.push({ t: s, k: s.startsWith('<![CDATA[') ? 'meta' : 'text' })

  let depth = 0
  let first = true
  const line = () => {
    if (!first) out.push({ t: '\n' })
    first = false
    out.push({ t: pad + '  '.repeat(depth) })
  }

  for (let i = 0; i < items.length; i++) {
    const s = items[i]
    if (isOpen(s)) {
      line()
      tagTokens(s, out)
      // Keep `<a>text</a>` and `<a></a>` on one line.
      if (items[i + 1] && isText(items[i + 1]) && items[i + 2] && isClose(items[i + 2])) {
        emitText(items[i + 1])
        tagTokens(items[i + 2], out)
        i += 2
      } else if (items[i + 1] && isClose(items[i + 1])) {
        tagTokens(items[i + 1], out)
        i += 1
      } else depth++
    } else if (isClose(s)) {
      depth = Math.max(0, depth - 1)
      line()
      tagTokens(s, out)
    } else if (s.startsWith('<!--')) {
      line()
      out.push({ t: s, k: 'meta' })
    } else if (s.startsWith('<?') || s.startsWith('<!')) {
      line()
      out.push({ t: s, k: s.startsWith('<![CDATA[') ? 'meta' : 'punct' })
    } else if (s.startsWith('<')) {
      line()
      tagTokens(s, out)
    } else {
      line()
      emitText(s)
    }
  }
}

/* ------------------------------ JSON ----------------------------- */

function jsonTokens(v: unknown, pad: string, out: Tok[]) {
  if (v === null || typeof v === 'boolean' || v === undefined) return void out.push({ t: String(v), k: 'kw' })
  if (typeof v === 'number' || typeof v === 'bigint') return void out.push({ t: String(v), k: 'num' })
  if (typeof v === 'string') {
    if (looksXml(v)) {
      out.push({ t: '\n' })
      return xmlTokens(v, pad + '  ', out)
    }
    const nested = tryJson(v)
    if (nested !== undefined && typeof nested === 'object' && nested !== null) return jsonTokens(nested, pad, out)
    return void out.push({ t: JSON.stringify(v), k: 'str' })
  }
  const isArr = Array.isArray(v)
  const entries: [string | null, unknown][] = isArr ? v.map((x) => [null, x]) : Object.entries(v as object)
  const [o, c] = isArr ? ['[', ']'] : ['{', '}']
  if (entries.length === 0) return void out.push({ t: o + c, k: 'punct' })
  out.push({ t: o, k: 'punct' })
  const inner = pad + '  '
  entries.forEach(([key, val], i) => {
    out.push({ t: '\n' + inner })
    if (key !== null) out.push({ t: JSON.stringify(key), k: 'key' }, { t: ': ', k: 'punct' })
    jsonTokens(val, inner, out)
    if (i < entries.length - 1) out.push({ t: ',', k: 'punct' })
  })
  out.push({ t: '\n' + pad }, { t: c, k: 'punct' })
}

function tokenize(value: unknown): Tok[] {
  const out: Tok[] = []
  if (typeof value === 'string' && looksXml(value)) xmlTokens(value, '', out)
  else jsonTokens(value, '', out)
  // Merge neighbours of the same kind to keep the span count low.
  const merged: Tok[] = []
  for (const tok of out) {
    const last = merged[merged.length - 1]
    if (last && last.k === tok.k) last.t += tok.t
    else merged.push({ ...tok })
  }
  return merged
}

export function CodeView({ value }: { value: unknown }) {
  const toks = useMemo(() => tokenize(value), [value])
  return (
    <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-[10px] bg-[#1c1c1e] p-3 font-mono text-[11.5px] leading-relaxed text-[#f2f2f7] ring-1 ring-white/10 [overflow-wrap:anywhere]">
      {toks.map((tok, i) => (tok.k ? <span key={i} className={kindCls[tok.k]}>{tok.t}</span> : tok.t))}
    </pre>
  )
}
