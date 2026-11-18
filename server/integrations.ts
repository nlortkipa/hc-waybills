/**
 * Shared plumbing for the external services: RS.ge (./rsge.ts) and SMS through
 * smsoffice.ge (./smsoffice.ts). Every call is written to the integration log,
 * shown on the API calls page.
 */
import { nowIso, uid } from '../src/lib/util.ts'
import type { IntegrationLog, ServiceName } from '../src/types.ts'
import { store as db } from './store.ts'

export class IntegrationError extends Error {
  readonly service: ServiceName
  /** The service answered and refused, so nothing was created (as opposed to a timeout or lost answer). */
  readonly rejected: boolean
  constructor(service: ServiceName, message: string, rejected = false) {
    super(message)
    this.service = service
    this.rejected = rejected
  }
}

export function log(entry: Omit<IntegrationLog, 'id' | 'at'>) {
  db.addLog({ id: uid('l'), at: nowIso(), ...entry })
}
