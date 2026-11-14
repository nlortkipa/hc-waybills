import type { Database } from '../types'

export const DB_VERSION = 7

/** Empty database: only the admin exists; everything else (including other users) is added through the app. */
export function createSeed(): Database {
  const users = [
    { id: 'u1', firstName: 'ნინო', lastName: 'ბერიძე', phone: '+995 555 00 00 01', email: 'nino@hc.ge', role: 'admin' as const },
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
      scaleFailRate: 0,
      autoWeigh: true,
      autoWeighDelaySec: 15,
    },
    cargo: { description: 'ღორღი 0–5 მმ', code: 'CRS-05', whsCode: 'WH-01', quantity: 25 },
  }
}
