import { CheckCircle2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { smsSettings } from '../api'
import { useDb } from '../api/store'
import { Button, Card, Field, Input, PageHeader, Section } from '../components/ui'
import { useToast } from '../components/toast'
import { formatDateTime, formatNumber, phoneKey } from '../lib/util'

/** SMS to drivers through smsoffice.ge: the account (from the server's .env) and a test message. Admin only. */
export function SmsSettings() {
  return (
    <>
      <PageHeader title="SMS" />
      <div className="space-y-4">
        <AccountCard />
        <TestCard />
      </div>
    </>
  )
}

/** The account in the server's .env: the server only runs once smsoffice.ge accepted the key. */
function AccountCard() {
  const sms = useDb().sms
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-emerald-500 text-white">
          <CheckCircle2 className="size-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">დაკავშირებულია smsoffice.ge-სთან</h2>
          <p className="text-sm text-slate-900">
            გამგზავნი <span className="font-mono text-[13px]">{sms.sender}</span>
          </p>
          <p className="text-xs text-slate-500">
            {sms.balance != null && <>ბალანსზე {formatNumber(sms.balance)} SMS</>}
            {sms.checkedAt && <> · შემოწმდა {formatDateTime(sms.checkedAt)}</>}
          </p>
          <p className="text-xs text-slate-500">API გასაღები და გამგზავნი იცვლება სერვერის .env ფაილში</p>
        </div>
      </div>
    </Card>
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
