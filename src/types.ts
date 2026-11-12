export type Role = 'admin' | 'operator' | 'report'

/** A delivery point of a carrier. Each one is weighed on its own scale. */
export interface Destination {
  id: string
  address: string
  /** Scale ID (per client spec, formerly the route name). */
  scaleId: string
}

export interface Carrier {
  id: string
  code: string
  name: string
  /** The single place every shipment of this carrier starts from. */
  startAddress: string
  /** One or more end addresses. */
  destinations: Destination[]
}

export interface Driver {
  id: string
  firstName: string
  lastName: string
  personalId: string
  phone: string
}

export interface Truck {
  id: string
  model: string
  plateNumber: string
  trailerNumber: string
}

/** Cargo as typed by the admin. Copied onto each shipment when it is created. */
export interface Cargo {
  description: string
  code: string
  whsCode: string
}

export interface User {
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
  | 'scale_failed' // could not hand over to scale service
  | 'at_scale' // scale service has the waybill, waiting for weighing
  | 'weighed' // real weight received

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'

export interface ShipmentEvent {
  at: string
  level: 'info' | 'success' | 'error'
  message: string
}

export interface ScalePayload {
  actionFlag: string
  processType: string
  docEntry: string
  docDate: string
  cardCode: string
  cardName: string
  u_ShipToCodeS: string
  shipToCode: string
  u_DriverName: string
  u_TruckNum: string
  u_TruckNum2: string
  u_Truck: string
  itemCode: string
  description: string
  quantity: number
  whsCode: string
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
  scale: {
    status: StepStatus
    error?: string
    sentAt?: string
    payload?: ScalePayload
    /** Real weight in kg as returned by the scale. */
    weightKg?: number
    weighedAt?: string
  }
  events: ShipmentEvent[]
}

export type ServiceName = 'RS.ge' | 'SMS' | 'Scale'

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
  scaleFailRate: number
  autoWeigh: boolean
  autoWeighDelaySec: number
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
