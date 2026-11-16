import { defaultRsSettings } from '../src/lib/rs.ts'
import type { Database } from '../src/types.ts'

export const DB_VERSION = 12

/** Empty database: only the admin exists (logs in with 575780323); everything else, including other users, is added through the app. */
export function createSeed(): Database {
  const users = [
    { id: 'u1', firstName: 'ადმინი', lastName: 'HC', phone: '575 78 03 23', email: 'admin@hc.ge', role: 'admin' as const },
  ]

  return {
    version: DB_VERSION,
    carriers: [],
    drivers: [],
    trucks: [],
    users,
    shipments: [],
    logs: [],
    settings: {
      latencyMs: 900,
      smsFailRate: 0,
    },
    cargo: { description: 'ღორღი 0–5 მმ', code: 'CRS-05', quantity: 25 },
    rs: defaultRsSettings(),
  }
}

/** Upgrades an older stored database in place instead of starting over. Returns null if it can't. */
export function migrate(db: Database): Database | null {
  let d = db as Database & { version: number }
  // v9 → v10: RS.ge settings added.
  if (d.version === 9) d = { ...d, version: 10, rs: defaultRsSettings() }
  // v10 → v11: RS.ge simulator and mode removed. IDs from the simulator mean nothing to RS.ge, so drop them.
  if (d.version === 10) {
    const { mode: _m, spSet: _ss, ...rs } = d.rs as Database['rs'] & { mode?: string }
    const { rsFailRate: _f, ...settings } = d.settings as Database['settings'] & { rsFailRate?: number }
    d = {
      ...d,
      version: 11,
      rs: { ...rs, sellerUnId: null, sellerUserId: null, sellerTin: '', sellerName: '', checkedAt: undefined },
      settings,
      shipments: d.shipments.map((s) => {
        const { rsMode: _rm, ...rest } = s as typeof s & { rsMode?: string }
        return rest.rsWaybillId ? { ...rest, rsWaybillId: undefined } : rest
      }),
    }
  }
  // v11 → v12: service user fields back (v11 had none).
  if (d.version === 11) d = { ...d, version: 12, rs: { ...d.rs, su: d.rs.su ?? '', sp: d.rs.sp ?? '' } }
  return d.version === DB_VERSION ? d : null
}
