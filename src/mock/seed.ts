import type { Database } from '../types'

export const DB_VERSION = 6

/** Empty database: only the login users exist; everything else is added through the app. */
export function createSeed(): Database {
  const users = [
    { id: 'u1', firstName: 'ნინო', lastName: 'ბერიძე', phone: '+995 555 00 00 01', email: 'nino@hc.ge', role: 'admin' as const },
    { id: 'u2', firstName: 'გიორგი', lastName: 'კაპანაძე', phone: '+995 555 00 00 02', email: 'giorgi@kavkasia.ge', role: 'operator' as const, carrierId: 'c1' },
    { id: 'u3', firstName: 'თამარ', lastName: 'ლომიძე', phone: '+995 555 00 00 03', email: 'tamar@rustavitrans.ge', role: 'operator' as const, carrierId: 'c2' },
    { id: 'u4', firstName: 'ანა', lastName: 'გელაშვილი', phone: '+995 555 00 00 04', email: 'ana@imereticargo.ge', role: 'operator' as const, carrierId: 'c3' },
    { id: 'u5', firstName: 'ლევან', lastName: 'კიკნაძე', phone: '+995 555 00 00 05', email: 'levan@hc.ge', role: 'report' as const },
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
