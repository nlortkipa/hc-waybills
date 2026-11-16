export type Role = 'admin' | 'operator' | 'report'

/**
 * Reference records referenced by shipments are never hard-deleted: they get a
 * deletedAt stamp, disappear from lists and pickers, but still resolve in history.
 */
export interface SoftDeletable {
  deletedAt?: string
}

/** A delivery point of a carrier. */
export interface Destination extends SoftDeletable {
  id: string
  address: string
  /** ID of the scale at this end address. */
  scaleId: string
}

export interface Carrier extends SoftDeletable {
  id: string
  name: string
  /** The single place every shipment of this carrier starts from. */
  startAddress: string
  /** One or more end addresses. */
  destinations: Destination[]
}

export interface Driver extends SoftDeletable {
  id: string
  firstName: string
  lastName: string
  personalId: string
  phone: string
}

export interface Truck extends SoftDeletable {
  id: string
  model: string
  plateNumber: string
  trailerNumber: string
}

/** Cargo as typed by the admin. Copied onto each shipment when it is created. */
export interface Cargo {
  description: string
  code: string
}

export interface User extends SoftDeletable {
  id: string
  firstName: string
  lastName: string
  phone: string
  email: string
  role: Role
  /** Operators are bound to exactly one carrier. */
  carrierId?: string
}

export type ShipmentStatus =
  | 'uploading' // sending to RS.ge
  | 'rs_failed' // RS.ge rejected / unreachable
  | 'uploaded' // waybill number received

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'

export interface ShipmentEvent {
  at: string
  level: 'info' | 'success' | 'error'
  message: string
}

export interface Shipment {
  id: string
  createdAt: string
  createdBy: string
  carrierId: string
  destinationId: string
  driverId: string
  truckId: string
  /** Snapshot of the admin-set cargo at creation time. */
  cargo: Cargo
  /** Declared quantity in tonnes. */
  quantity: number
  status: ShipmentStatus
  waybillNumber?: string
  rs: { status: StepStatus; error?: string; at?: string }
  sms: { status: StepStatus; error?: string; at?: string; to?: string; text?: string }
  events: ShipmentEvent[]
}

export type ServiceName = 'RS.ge' | 'SMS'

export interface IntegrationLog {
  id: string
  at: string
  service: ServiceName
  direction: 'out' | 'in'
  endpoint: string
  request: unknown
  response: unknown
  ok: boolean
  durationMs: number
  shipmentId?: string
}

export interface MockSettings {
  latencyMs: number
  rsFailRate: number
  smsFailRate: number
}

/** Cargo and declared quantity applied to every new shipment. Set by an admin. */
export interface CargoDefaults extends Cargo {
  /** Declared quantity in tonnes. */
  quantity: number
}

export interface Database {
  version: number
  carriers: Carrier[]
  drivers: Driver[]
  trucks: Truck[]
  users: User[]
  shipments: Shipment[]
  logs: IntegrationLog[]
  settings: MockSettings
  cargo: CargoDefaults
}
