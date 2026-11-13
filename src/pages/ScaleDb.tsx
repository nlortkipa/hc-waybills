import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Database, KeyRound, RefreshCw, Search, ServerOff, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { refreshScaleStatus, scaleApiUrl, scaleInspector, scaleInspectorUrl, useScaleStatus, type ScaleColumn, type ScaleRow, type ScaleTable, type ScaleTablePage } from '../api/scaleInspector'
import { Badge, Button, Card, EmptyState, Input, Modal, PageHeader } from '../components/ui'
import { cx } from '../lib/util'

const PAGE = 50
const fmt = (n: number) => n.toLocaleString('en-US').replaceAll(',', ' ')

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function ScaleDb() {
  const { status, checked, online } = useScaleStatus()
  const [params, setParams] = useSearchParams()
  const selected = params.get('t')
  const [tables, setTables] = useState<ScaleTable[] | null>(null)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!online) return
    const ctrl = new AbortController()
    scaleInspector
      .tables(ctrl.signal)
      .then((t) => {
        setTables(t)
        setTablesError(null)
      })
      .catch((e: Error) => !ctrl.signal.aborted && setTablesError(e.message))
    return () => ctrl.abort()
  }, [online, reload])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (tables ?? []).filter((t) => !q || `${t.schema}.${t.name}`.toLowerCase().includes(q))
  }, [tables, filter])
  const totalRows = useMemo(() => (tables ?? []).reduce((s, t) => s + t.rows, 0), [tables])

  const select = (key: string | null) => setParams(key ? { t: key } : {}, { replace: !!selected && !!key })

  const header = (
    <PageHeader
      title="სასწორის ბაზა"
      subtitle="Scale Service-ის მონაცემთა ბაზის ცხრილები (მხოლოდ წაკითხვა)."
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="size-3.5" />}
          onClick={() => {
            void refreshScaleStatus()
            setReload((n) => n + 1)
          }}
        >
          განახლება
        </Button>
      }
    />
  )

  if (!online) {
    return (
      <>
        {header}
        <Card>
          {!checked ? (
            <EmptyState icon={<RefreshCw className="animate-spin" />} title="მოწმდება…" />
          ) : (
            <EmptyState
              icon={<ServerOff />}
              title={status ? (status.api.up ? 'ბაზა მიუწვდომელია' : 'Scale API არ არის გაშვებული') : 'სასწორის სერვისი არ არის გაშვებული'}
              text={
                status
                  ? (status.db.error ?? status.api.error ?? undefined)
                  : scaleInspectorUrl
                    ? `${scaleInspectorUrl} არ პასუხობს. გაუშვი: npm run scale up`
                    : 'VITE_SCALE_INSPECTOR_URL არ არის მითითებული.'
              }
              action={
                <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void refreshScaleStatus()}>
                  ხელახლა ცდა
                </Button>
              }
            />
          )}
        </Card>
      </>
    )
  }

  return (
    <>
      {header}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone="green" dot>
          API · HTTP {status?.api.status}
          {status?.api.ms != null && ` · ${status.api.ms} მწმ`}
        </Badge>
        <Badge tone="blue">
          <Database className="size-3" />
          {status?.db.name}
        </Badge>
        {tables && (
          <Badge tone="gray">
            {tables.length} ცხრილი · {fmt(totalRows)} ჩანაწერი
          </Badge>
        )}
        {status?.api.swagger && scaleApiUrl && (
          <a href={`${scaleApiUrl}/swagger`} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand-600 hover:text-brand-700">
            Swagger →
          </a>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className={cx('min-w-0 overflow-hidden lg:block', selected && 'hidden')}>
          <div className="relative border-b border-separator p-3">
            <Search className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-1/2 text-slate-400" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="ცხრილის ძებნა…" className="pl-9" />
          </div>
          {tablesError ? (
            <p className="p-4 text-sm text-rose-600">{tablesError}</p>
          ) : !tables ? (
            <p className="p-4 text-sm text-slate-500">იტვირთება…</p>
          ) : shown.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">ცხრილი ვერ მოიძებნა</p>
          ) : (
            <ul className="max-h-[70dvh] divide-y divide-separator overflow-y-auto">
              {shown.map((t) => {
                const key = `${t.schema}.${t.name}`
                const active = key === selected
                return (
                  <li key={key}>
                    <button onClick={() => select(key)} className={cx('flex w-full items-center gap-3 px-4 py-2.5 text-left', active ? 'bg-brand-600 text-white' : 'hover:bg-fill')}>
                      <Table2 className={cx('size-4 shrink-0', active ? 'text-white' : 'text-brand-600')} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium">{t.name}</span>
                        {t.schema !== 'dbo' && <span className={cx('block text-xs', active ? 'text-white/70' : 'text-slate-500')}>{t.schema}</span>}
                      </span>
                      <span className={cx('shrink-0 text-xs tabular-nums', active ? 'text-white/80' : 'text-slate-500')}>{fmt(t.rows)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <div className={cx('min-w-0', !selected && 'hidden lg:block')}>
          {selected ? (
            <TableView key={selected + reload} tableKey={selected} onBack={() => select(null)} />
          ) : (
            <Card>
              <EmptyState icon={<Table2 />} title="აირჩიე ცხრილი" text="მარცხნივ სიიდან აირჩიე ცხრილი მისი სვეტებისა და ჩანაწერების სანახავად." />
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function TableView({ tableKey, onBack }: { tableKey: string; onBack: () => void }) {
  const dot = tableKey.indexOf('.')
  const schema = tableKey.slice(0, dot)
  const table = tableKey.slice(dot + 1)
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 300)
  // Offset belongs to one search/sort combination; changing either jumps back to page 1.
  const filterKey = JSON.stringify([sort, dq])
  const [paging, setPaging] = useState({ key: filterKey, offset: 0 })
  const offset = paging.key === filterKey ? paging.offset : 0
  const setOffset = (n: number) => setPaging({ key: filterKey, offset: n })
  const reqKey = `${filterKey}@${offset}`
  const [result, setResult] = useState<{ key: string; page?: ScaleTablePage; error?: string } | null>(null)
  const page = result?.page ?? null
  const error = result?.error ?? null
  const loading = result?.key !== reqKey
  const [openRow, setOpenRow] = useState<ScaleRow | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    scaleInspector
      .table(schema, table, { limit: PAGE, offset, sort: sort?.col, dir: sort?.dir, q: dq || undefined }, ctrl.signal)
      .then((p) => setResult({ key: reqKey, page: p }))
      .catch((e: Error) => !ctrl.signal.aborted && setResult((r) => ({ key: reqKey, page: r?.page, error: e.message })))
    return () => ctrl.abort()
  }, [schema, table, offset, sort, dq, reqKey])

  const toggleSort = (col: string) => setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null))

  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-separator px-4 py-3">
        <button onClick={onBack} className="pressable -ml-1 grid size-8 place-items-center rounded-full text-brand-600 hover:bg-fill lg:hidden" aria-label="უკან">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-slate-900">
            {schema !== 'dbo' && <span className="text-slate-500">{schema}.</span>}
            {table}
          </h2>
          <p className="text-xs text-slate-500">
            {page ? `${fmt(page.total)} ჩანაწერი · ${page.columns.length} სვეტი` : '…'}
            {loading && page && ' · იტვირთება…'}
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ძებნა ყველა სვეტში…" className="pl-9" />
        </div>
      </div>

      {error ? (
        <p className="p-4 text-sm text-rose-600">{error}</p>
      ) : !page ? (
        <p className="p-4 text-sm text-slate-500">იტვირთება…</p>
      ) : (
        <>
          <div className={cx('max-h-[65dvh] overflow-auto transition-opacity', loading && 'opacity-60')}>
            <table className="w-full border-separate border-spacing-0 text-left text-[13px]">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  {page.columns.map((c) => (
                    <th key={c.name} className="border-b border-separator px-3 py-2 font-semibold whitespace-nowrap text-slate-700">
                      <button onClick={() => toggleSort(c.name)} className="inline-flex items-center gap-1 hover:text-brand-600" title={columnType(c)}>
                        {c.pk && <KeyRound className="size-3 text-amber-500" />}
                        {c.name}
                        {sort?.col === c.name && (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                      </button>
                      <span className="block text-[11px] font-normal text-slate-400">{columnType(c)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.length === 0 ? (
                  <tr>
                    <td colSpan={page.columns.length} className="px-3 py-10 text-center text-slate-500">
                      {dq ? 'შედეგი ვერ მოიძებნა' : 'ცხრილი ცარიელია'}
                    </td>
                  </tr>
                ) : (
                  page.rows.map((r, i) => (
                    <tr key={i} onClick={() => setOpenRow(r)} className="cursor-pointer hover:bg-fill">
                      {page.columns.map((c) => (
                        <td key={c.name} className="max-w-[280px] truncate border-b border-separator px-3 py-1.5 font-mono text-[12px] text-slate-800">
                          <Value v={r[c.name]} />
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs text-slate-500">
            <span className="tabular-nums">
              {page.total === 0 ? '0' : `${fmt(page.offset + 1)}–${fmt(page.offset + page.rows.length)}`} / {fmt(page.total)}
            </span>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="წინა გვერდი">
                <ChevronLeft className="size-4" />
              </Button>
              <Button variant="ghost" size="sm" disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)} aria-label="შემდეგი გვერდი">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </>
      )}

      <Modal open={!!openRow} onClose={() => setOpenRow(null)} title={table} wide>
        {openRow && page && (
          <dl className="divide-y divide-separator overflow-hidden rounded-xl bg-surface sm:bg-fill/50">
            {page.columns.map((c) => (
              <div key={c.name} className="grid grid-cols-1 gap-1 px-4 py-2.5 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
                <dt className="min-w-0">
                  <span className="flex items-center gap-1 text-[13px] font-medium text-slate-900">
                    {c.pk && <KeyRound className="size-3 text-amber-500" />}
                    {c.name}
                  </span>
                  <span className="text-[11px] text-slate-500">{columnType(c)}</span>
                </dt>
                <dd className="min-w-0 font-mono text-[12.5px] break-words whitespace-pre-wrap text-slate-800">
                  <Value v={openRow[c.name]} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Modal>
    </Card>
  )
}

function columnType(c: ScaleColumn) {
  const len = ['varchar', 'char', 'varbinary', 'binary'].includes(c.type) ? c.maxLength : ['nvarchar', 'nchar'].includes(c.type) ? c.maxLength / 2 : null
  const size = len == null ? '' : len < 0 ? '(max)' : `(${len})`
  return `${c.type}${size}${c.nullable ? '' : ' not null'}${c.identity ? ' identity' : ''}`
}

function Value({ v }: { v: ScaleRow[string] }) {
  if (v === null || v === undefined) return <span className="text-slate-400 italic">NULL</span>
  if (typeof v === 'boolean') return <span className={v ? 'text-emerald-600' : 'text-slate-500'}>{String(v)}</span>
  if (typeof v === 'number') return <span className="tabular-nums">{v}</span>
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return <>{v.replace('T', ' ').replace(/\.000Z$|Z$/, '')}</>
  return <>{v}</>
}
