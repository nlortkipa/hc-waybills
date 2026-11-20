import { CheckCircle2, FileStack } from 'lucide-react'
import { useState } from 'react'
import { rsSettings } from '../api'
import { useDb } from '../api/store'
import { Card, LinkButton, PageHeader, RefreshButton } from '../components/ui'
import { useToast } from '../components/toast'

/* ------------------------------- Screen ------------------------------- */

/** RS.ge: the service user (from the server's .env). Everything else on a waybill comes from its route. Admin only. */
export function RsSettings() {
  return (
    <>
      <PageHeader
        title="RS.ge"
        actions={
          <LinkButton to="/waybills" variant="secondaryBrand" size="sm" icon={<FileStack className="size-3.5" />}>
            ზედნადებები RS.ge-ზე
          </LinkButton>
        }
      />
      <ConnectionCard />
    </>
  )
}

/* ------------------------------ Connection ------------------------------ */

/** The service user from the server's .env: the server only runs once RS.ge accepted it. */
function ConnectionCard() {
  const rs = useDb().rs
  return (
    <Card className="p-5 sm:p-6">
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
          <p className="text-xs text-slate-500">
            სერვისის მომხმარებელი <span className="font-mono">{rs.su}</span> · იცვლება სერვერის .env ფაილში
          </p>
          {rs.syncError && <SyncLine error={rs.syncError} />}
        </div>
      </div>
    </Card>
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
