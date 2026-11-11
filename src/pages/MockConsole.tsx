import { ArrowDownLeft, ArrowUpRight, ChevronDown, RotateCcw, Trash2, Waypoints } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { mock } from '../api'
import { Badge, Button, Card, ConfirmModal, EmptyState, JsonBlock, PageHeader, Toggle } from '../components/ui'
import { useToast } from '../components/toast'
import { cx, formatTime } from '../lib/util'
import { useDb } from '../mock/db'
import { useUser } from '../session'
import type { ServiceName } from '../types'

const serviceTone: Record<ServiceName, 'blue' | 'violet' | 'amber'> = { 'RS.ge': 'blue', SMS: 'violet', Scale: 'amber' }
const serviceLabel: Record<ServiceName, string> = { 'RS.ge': 'RS.ge', SMS: 'SMS', Scale: 'სასწორი' }

export function MockConsole() {
  const d = useDb()
  const user = useUser()
  const toast = useToast()
  const s = d.settings
  const [svc, setSvc] = useState<ServiceName | ''>('')
  const [open, setOpen] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const visibleIds = useMemo(() => {
    if (user.role !== 'operator') return null
    return new Set(d.shipments.filter((x) => x.carrierId === user.carrierId).map((x) => x.id))
  }, [d.shipments, user])
  const logs = d.logs.filter((l) => (!svc || l.service === svc) && (!visibleIds || !l.shipmentId || visibleIds.has(l.shipmentId)))

  return (
    <>
      <PageHeader title="სატესტო პანელი" subtitle="მართე იმიტირებული RS.ge, SMS და სასწორის სერვისები და ნახე ყველა მოთხოვნა." />

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">სიმულაცია</h2>
            <div className="mt-4 space-y-5">
              <Slider label="ქსელის დაყოვნება" value={s.latencyMs} min={100} max={4000} step={100} unit=" მწმ" onChange={(v) => mock.updateSettings({ latencyMs: v })} />
              <Slider label="RS.ge შეცდომების %" value={s.rsFailRate} min={0} max={100} step={5} unit="%" onChange={(v) => mock.updateSettings({ rsFailRate: v })} />
              <Slider label="SMS შეცდომების %" value={s.smsFailRate} min={0} max={100} step={5} unit="%" onChange={(v) => mock.updateSettings({ smsFailRate: v })} />
              <Slider label="სასწორის შეცდომების %" value={s.scaleFailRate} min={0} max={100} step={5} unit="%" onChange={(v) => mock.updateSettings({ scaleFailRate: v })} />
              <div className="border-t border-slate-100 pt-4">
                <Toggle checked={s.autoWeigh} onChange={(v) => mock.updateSettings({ autoWeigh: v })} label="სასწორი ავტომატურად წონის მანქანებს" />
                {s.autoWeigh && (
                  <div className="mt-4">
                    <Slider label="აწონვის დაყოვნება" value={s.autoWeighDelaySec} min={3} max={120} step={1} unit=" წმ" onChange={(v) => mock.updateSettings({ autoWeighDelaySec: v })} />
                  </div>
                )}
                <p className="mt-2 text-xs text-slate-500">გამორთვისას გამოიყენე „აწონვის სიმულაცია“ რეისის გვერდზე.</p>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">სადემო მონაცემები</h2>
            <p className="mt-1 text-sm text-slate-500">ინახება მხოლოდ ამ ბრაუზერში. განულება აღადგენს საწყის კარიერებს, მძღოლებს, მანქანებს, მომხმარებლებს და სანიმუშო რეისებს.</p>
            <Button variant="secondary" className="mt-4 w-full" icon={<RotateCcw className="size-4" />} onClick={() => setConfirmReset(true)}>
              მონაცემების განულება
            </Button>
          </Card>
        </div>

        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">ინტეგრაციების ლოგი</h2>
            <div className="flex items-center gap-1">
              {(['', 'RS.ge', 'SMS', 'Scale'] as const).map((x) => (
                <button
                  key={x || 'all'}
                  onClick={() => setSvc(x)}
                  className={cx('h-7 rounded-lg px-2.5 text-xs font-medium', svc === x ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100')}
                >
                  {x ? serviceLabel[x] : 'ყველა'}
                </button>
              ))}
              <button onClick={() => mock.clearLogs()} className="ml-1 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="ლოგის გასუფთავება" aria-label="ლოგის გასუფთავება">
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
          {logs.length === 0 ? (
            <EmptyState icon={<Waypoints className="size-6" />} title="მოთხოვნები ჯერ არ არის" text="შექმენი რეისი და ყველა RS.ge, SMS და სასწორის მოთხოვნა აქ გამოჩნდება." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {logs.map((l) => {
                const isOpen = open === l.id
                return (
                  <li key={l.id}>
                    <button onClick={() => setOpen(isOpen ? null : l.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5">
                      <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg', l.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600')}>
                        {l.direction === 'out' ? <ArrowUpRight className="size-4" /> : <ArrowDownLeft className="size-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Badge tone={serviceTone[l.service]}>{serviceLabel[l.service]}</Badge>
                          {!l.ok && <Badge tone="red">შეცდომა</Badge>}
                        </div>
                        <p className="mt-1 truncate font-mono text-xs text-slate-600">{l.endpoint}</p>
                      </div>
                      <div className="shrink-0 text-right text-xs text-slate-400 tabular-nums">
                        <p>{formatTime(l.at)}</p>
                        {l.direction === 'out' && <p>{l.durationMs} მწმ</p>}
                      </div>
                      <ChevronDown className={cx('size-4 shrink-0 text-slate-300 transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="grid gap-3 bg-slate-50/70 px-4 pb-4 sm:px-5 xl:grid-cols-2">
                        <div className="min-w-0">
                          <p className="mb-1.5 text-xs font-medium text-slate-500">მოთხოვნა</p>
                          <JsonBlock value={l.request} />
                        </div>
                        <div className="min-w-0">
                          <p className="mb-1.5 text-xs font-medium text-slate-500">პასუხი</p>
                          <JsonBlock value={l.response} />
                        </div>
                        {l.shipmentId && (
                          <Link to={`/shipments/${l.shipmentId}`} className="text-xs font-medium text-brand-600 hover:text-brand-700">
                            რეისის გახსნა →
                          </Link>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>

      <ConfirmModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="განულდეს მონაცემები?"
        message="ამ ბრაუზერში არსებული ყველა რეისი, ცნობარების ცვლილება და ლოგი ჩანაცვლდება საწყისი მონაცემებით."
        confirmLabel="განულება"
        onConfirm={() => {
          mock.reset()
          setConfirmReset(false)
          toast('success', 'მონაცემები განულდა')
        }}
      />
    </>
  )
}

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="mb-2 flex justify-between text-sm">
        <span className="text-slate-700">{label}</span>
        <span className="font-medium tabular-nums text-slate-900">
          {value}
          {unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-brand-600" />
    </label>
  )
}
