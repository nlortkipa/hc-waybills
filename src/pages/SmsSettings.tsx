import { AlertTriangle, CheckCircle2, Unplug } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { smsSettings } from '../api'
import { useDb } from '../api/store'
import { Button, Card, ConfirmModal, Field, Input, PageHeader } from '../components/ui'
import { useToast } from '../components/toast'
import { formatDateTime, formatNumber, phoneKey } from '../lib/util'
import type { SmsSettings as Sms } from '../types'

/** Sender names smsoffice.ge accepts (the server checks the same). */
const SENDER_RE = /^[A-Za-z0-9.\- ]{1,11}$/

const isConnected = (sms: Sms) => !!sms.apiKeySet && !!sms.sender

/** SMS to drivers through smsoffice.ge: the account (API key + sender) and a test message. Admin only. */
export function SmsSettings() {
  const sms = useDb().sms
  const connected = isConnected(sms)
  return (
    <>
      <PageHeader title="SMS" />
      <div className="space-y-4">
        {connected ? (
          <div className="flex gap-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900 ring-1 ring-emerald-200">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <p>SMS ჩართულია — მძღოლები შეტყობინებას მიიღებენ გამგზავნით „{sms.sender}“.</p>
          </div>
        ) : (
          <div className="flex gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <p>SMS არ არის დაყენებული — რეისებზე SMS-ის ნაბიჯი შეცდომით დასრულდება. დაყენების შემდეგ შეგიძლია ხელახლა გაგზავნო.</p>
          </div>
        )}
        <AccountCard />
        {connected && <TestCard />}
      </div>
    </>
  )
}

function AccountCard() {
  const sms = useDb().sms
  const toast = useToast()
  const connected = isConnected(sms)
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [sender, setSender] = useState(sms.sender)
  const [errors, setErrors] = useState<{ apiKey?: string; sender?: string }>({})
  const [busy, setBusy] = useState(false)
  const [askDisconnect, setAskDisconnect] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const s = sender.trim()
    const errs = {
      apiKey: apiKey.trim() || sms.apiKeySet ? '' : 'სავალდებულო ველი',
      sender: !s ? 'სავალდებულო ველი' : SENDER_RE.test(s) ? '' : 'მაქსიმუმ 11 ლათინური ასო, ციფრი, „-“ ან „.“',
    }
    setErrors(errs)
    if (errs.apiKey || errs.sender) return
    setBusy(true)
    try {
      const r = await smsSettings.save({ apiKey: apiKey.trim() || undefined, sender: s })
      setApiKey('')
      setEditing(false)
      toast('success', `შენახულია — ბალანსზე ${formatNumber(r.balance)} SMS`)
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await smsSettings.disconnect()
      setApiKey('')
      setSender('')
      setAskDisconnect(false)
      toast('success', 'SMS გაითიშა')
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
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
              <CheckCircle2 className="size-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900">დაკავშირებულია smsoffice.ge-სთან</h3>
              <p className="text-sm text-slate-900">
                გამგზავნი <span className="font-mono text-[13px]">{sms.sender}</span>
              </p>
              <p className="text-xs text-slate-500">
                {sms.balance != null && <>ბალანსზე {formatNumber(sms.balance)} SMS</>}
                {sms.checkedAt && <> · შემოწმდა {formatDateTime(sms.checkedAt)}</>}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setSender(sms.sender)
                setApiKey('')
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
          title="SMS-ის გათიშვა"
          message="API გასაღები წაიშლება და მძღოლები SMS-ს აღარ მიიღებენ, სანამ თავიდან არ დააყენებ."
          confirmLabel="გათიშვა"
          busy={busy}
          onConfirm={() => void disconnect()}
          onClose={() => setAskDisconnect(false)}
        />
      </Card>
    )
  }

  return (
    <form onSubmit={save} noValidate>
      <Section title="smsoffice.ge ანგარიში">
        <Field label="API გასაღები" error={errors.apiKey} hint={sms.apiKeySet && !apiKey ? 'შენახულია — დატოვე ცარიელი, თუ არ ცვლი' : undefined}>
          <Input
            type="password"
            value={apiKey}
            autoComplete="new-password"
            className="font-mono"
            placeholder={sms.apiKeySet ? '••••••' : ''}
            invalid={!!errors.apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              setErrors((x) => ({ ...x, apiKey: '' }))
            }}
          />
        </Field>
        <Field label="გამგზავნის სახელი" error={errors.sender}>
          <Input
            value={sender}
            autoComplete="off"
            maxLength={11}
            className="font-mono"
            placeholder="HC"
            invalid={!!errors.sender}
            onChange={(e) => {
              setSender(e.target.value)
              setErrors((x) => ({ ...x, sender: '' }))
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
            შემოწმება და შენახვა
          </Button>
        </div>
      </Section>
    </form>
  )
}

/** Sends one message with the stored account: the only way to see the sender name is accepted. */
function TestCard() {
  const toast = useToast()
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!/^5\d{8}$/.test(phoneKey(phone))) return setError('ფორმატი: 5XX XX XX XX')
    setBusy(true)
    try {
      await smsSettings.test(phone)
      toast('success', 'სატესტო SMS გაიგზავნა')
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={send} noValidate>
      <Section title="სატესტო SMS">
        <Field label="ტელეფონი" error={error}>
          <Input
            type="tel"
            value={phone}
            inputMode="tel"
            placeholder="5XX XX XX XX"
            invalid={!!error}
            onChange={(e) => {
              setPhone(e.target.value)
              setError('')
            }}
          />
        </Field>
        <div className="flex items-end justify-end">
          <Button type="submit" variant="secondary" loading={busy}>
            გაგზავნა
          </Button>
        </div>
      </Section>
    </form>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-5 sm:p-6">
      <h3 className="mb-5 text-sm font-semibold text-slate-900">{title}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </Card>
  )
}
