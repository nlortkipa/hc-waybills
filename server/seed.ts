import type { Database } from '../src/types.ts'

export const DB_VERSION = 9

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
      rsFailRate: 0,
      smsFailRate: 0,
    },
    cargo: { description: 'ღორღი 0–5 მმ', code: 'CRS-05', quantity: 25 },
  }
}
