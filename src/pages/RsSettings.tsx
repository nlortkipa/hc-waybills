import { CheckCircle2, FileStack, Unplug } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { rsSettings } from '../api'
import { useDb } from '../api/store'
import { Button, Card, ConfirmModal, Field, Input, LinkButton, PageHeader, RefreshButton, Section } from '../components/ui'
import { useToast } from '../components/toast'
import type { RsSettings } from '../types'

/** A service user is stored (the seller is then read from RS.ge; it isn't stored). */
const isConnected = (rs: RsSettings) => !!rs.su && !!rs.spSet

/* ------------------------------- Screen ------------------------------- */

/** RS.ge: the service user, connected once. Everything else on a waybill comes from its route. Admin only. */
export function RsSettings() {
  const d = useDb()
  const connected = isConnected(d.rs)

  return (
    <>
      <PageHeader
        title="RS.ge"
        actions={
          connected && (
            <LinkButton to="/waybills" variant="secondaryBrand" size="sm" icon={<FileStack className="size-3.5" />}>
              ზედნადებები RS.ge-ზე
            </LinkButton>
          )
        }
      />
      <ConnectionCard />
    </>
  )
}

/* ------------------------------ Connection ------------------------------ */

/** RS.ge service user names are "<name>:<taxpayer id>"; the form asks for the two parts separately. */
function splitSu(su: string) {
  const i = su.lastIndexOf(':')
  return i < 0 ? { name: su, id: '' } : { name: su.slice(0, i), id: su.slice(i + 1) }
}

function ConnectionCard() {
  const rs = useDb().rs
  const toast = useToast()
  const connected = isConnected(rs)
  const [editing, setEditing] = useState(false)
  const [suName, setSuName] = useState(() => splitSu(rs.su).name)
  const [suId, setSuId] = useState(() => splitSu(rs.su).id)
  const [sp, setSp] = useState('')
  const [errors, setErrors] = useState<{ suName?: string; suId?: string; sp?: string }>({})
  const su = `${suName.trim()}:${suId.trim()}`
  const [busy, setBusy] = useState(false)
  const [askDisconnect, setAskDisconnect] = useState(false)
  /** The stored password can be re-used while the user name stays the same. */
  const keepsPassword = !!rs.spSet && su === rs.su
  const setUser = (part: 'suName' | 'suId', set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value)
    setErrors((x) => ({ ...x, [part]: '' }))
  }

  const connect = async (e: FormEvent) => {
    e.preventDefault()
    const id = suId.trim()
    const errs = {
      suName: !suName.trim() ? 'სავალდებულო ველი' : suName.includes(':') ? 'სახელში „:“ არ უნდა იყოს' : '',
      suId: !id ? 'სავალდებულო ველი' : /^\d{9}$|^\d{11}$/.test(id) ? '' : 'უნდა იყოს 9 ან 11 ციფრი',
      sp: sp || keepsPassword ? '' : 'სავალდებულო ველი',
    }
    setErrors(errs)
    if (errs.suName || errs.suId || errs.sp) return
    setBusy(true)
    try {
      const r = await rsSettings.connect({ su, sp: sp || undefined })
      setSp('')
      setEditing(false)
      toast('success', `დაკავშირებულია: ${r.name} (${r.tin})`)
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await rsSettings.disconnect()
      setSuName('')
      setSuId('')
      setSp('')
      setAskDisconnect(false)
      toast('success', 'RS.ge-სთან კავშირი გაითიშა')
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (connected && !editing) {
    return (
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-emerald-500 text-white">
              <CheckCircle2 className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">დაკავშირებულია RS.ge-სთან</h2>
              {rs.sellerTin ? (
                <p className="text-sm text-slate-900">
                  {rs.sellerName} <span className="font-mono text-[13px] text-slate-500">({rs.sellerTin})</span>
                </p>
              ) : rs.accountError ? (
                <p className="text-sm text-amber-700">გამყიდველი RS.ge-დან ვერ წაიკითხა: {rs.accountError}</p>
              ) : (
                <p className="text-sm text-slate-500">გამყიდველი იკითხება RS.ge-დან…</p>
              )}
              {rs.syncError && <SyncLine error={rs.syncError} />}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setSuName(splitSu(rs.su).name)
                setSuId(splitSu(rs.su).id)
                setSp('')
                setErrors({})
                setEditing(true)
              }}
            >
              შეცვლა
            </Button>
            <Button type="button" variant="ghost" size="sm" icon={<Unplug className="size-3.5" />} onClick={() => setAskDisconnect(true)}>
              გათიშვა
            </Button>
          </div>
        </div>
        <ConfirmModal
          open={askDisconnect}
          title="გაითიშოს RS.ge?"
          message="ახალი ზედნადებები ვერ აიტვირთება."
          confirmLabel="გათიშვა"
          busy={busy}
          onConfirm={() => void disconnect()}
          onClose={() => setAskDisconnect(false)}
        />
      </Card>
    )
  }

  return (
    <form onSubmit={connect} noValidate>
      <Section title="დაკავშირება RS.ge-სთან">
        <Field label="სერვისის მომხმარებლის სახელი" error={errors.suName}>
          <Input value={suName} autoComplete="off" className="font-mono" placeholder="NAME" invalid={!!errors.suName} onChange={setUser('suName', setSuName)} />
        </Field>
        <Field label="საიდენტიფიკაციო კოდი" error={errors.suId}>
          <Input value={suId} inputMode="numeric" autoComplete="off" className="font-mono" placeholder="206322102" invalid={!!errors.suId} onChange={setUser('suId', setSuId)} />
        </Field>
        <Field label="პაროლი" error={errors.sp} hint={keepsPassword && !sp ? 'შენახულია — დატოვე ცარიელი, თუ არ ცვლი' : undefined}>
          <Input
            type="password"
            value={sp}
            autoComplete="new-password"
            placeholder={keepsPassword ? '••••••' : ''}
            invalid={!!errors.sp}
            onChange={(e) => {
              setSp(e.target.value)
              setErrors((x) => ({ ...x, sp: '' }))
            }}
          />
        </Field>
        <div className="flex justify-end gap-2 sm:col-span-2">
          {editing && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              გაუქმება
            </Button>
          )}
          <Button type="submit" loading={busy}>
            დაკავშირება
          </Button>
        </div>
      </Section>
    </form>
  )
}

/** Shown only when checking RS.ge for changed waybills failed: why, and a retry button. */
function SyncLine({ error }: { error: string }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await rsSettings.syncNow()
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
      <span className="text-amber-700">{error}</span>
      <RefreshButton busy={busy} onClick={() => void run()}>ხელახლა</RefreshButton>
    </p>
  )
}
