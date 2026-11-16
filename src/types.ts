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
  /** 'GE' = Georgian citizen (default), 'foreign' = foreigner. Sent to RS.ge as CHEK_DRIVER_TIN. */
  citizenship?: 'GE' | 'foreign'
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
  /** RS.ge internal waybill ID returned by save_waybill. Kept so retries activate it instead of creating a duplicate. */
  rsWaybillId?: number
  /** What was sent to RS.ge, fixed when the shipment is created so retries send the same waybill. */
  rsWaybill?: RsWaybillPayload
  /** After upload: the waybill was completed (close_waybill) or cancelled (ref_waybill) on RS.ge. */
  waybillState?: 'closed' | 'cancelled'
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
  smsFailRate: number
}

/** Cargo and declared quantity applied to every new shipment. Set by an admin. */
export interface CargoDefaults extends Cargo {
  /** Declared quantity in tonnes. */
  quantity: number
}

/** An item of an RS.ge reference list (units, transport types). */
export interface RsRefItem {
  id: number
  name: string
}

/**
 * RS.ge waybill settings: the same on every shipment, set by the admin.
 * The password (sp) never leaves the server: clients get '' plus spSet.
 */
export interface RsSettings {
  /** Service user (სერვისის მომხმარებელი). */
  su: string
  /** Service user password. Empty in every client copy. */
  sp: string
  /** True when a password is stored on the server. Set only in client copies. */
  spSet?: boolean

  /* Seller: the taxpayer that owns the service user, filled in by "check connection" (or on the first upload). */
  sellerUnId: number | null
  sellerUserId: number | null
  sellerTin: string
  sellerName: string
  checkedAt?: string

  /* Buyer (receiver of the goods). */
  buyerTin: string
  buyerName: string
  buyerForeign: boolean

  /** Optional: tax ID of a separate transport company (TRANSPORTER_TIN). */
  transporterTin: string
  /** TRANS_ID: transport type from get_trans_types. */
  transId: number
  /** TRANS_TXT: required when the transport type is "other". */
  transTxt: string
  /** TRAN_COST_PAYER: 1 buyer, 2 seller. */
  tranCostPayer: 1 | 2
  /** TRANSPORT_COAST (sic): transport cost, GEL. */
  transportCost: number

  /** UNIT_ID from get_waybill_units; 99 = "other", then unitTxt is the unit name. */
  unitId: number
  unitTxt: string
  /** Price per unit, GEL. AMOUNT = quantity × price. */
  price: number
  /** VAT_TYPE: 0 ordinary, 1 zero-rated, 2 exempt. */
  vatType: 0 | 1 | 2

  receptionInfo: string
  receiverInfo: string
  /** Extra COMMENT text. The trailer number is always added to the comment. */
  comment: string

  /** Reference lists cached from RS.ge by "check connection". */
  units: RsRefItem[]
  transTypes: RsRefItem[]
}

/** Everything one waybill needs, in RS.ge terms. Built when a shipment is created. */
export interface RsWaybillPayload {
  type: number
  buyerTin: string
  buyerForeign: boolean
  buyerName: string
  startAddress: string
  endAddress: string
  driverTin: string
  driverForeign: boolean
  driverName: string
  carNumber: string
  transId: number
  transTxt: string
  tranCostPayer: 1 | 2
  transportCost: number
  transporterTin: string
  receptionInfo: string
  receiverInfo: string
  comment: string
  goods: {
    name: string
    unitId: number
    unitTxt: string
    quantity: number
    price: number
    amount: number
    barCode: string
    vatType: 0 | 1 | 2
  }[]
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
  rs: RsSettings
}
