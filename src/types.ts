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

/**
 * A route the admin opened for a carrier: its start address → one of its end addresses.
 * Operators pick one of these for each shipment.
 */
export interface CarrierRoute extends SoftDeletable {
  id: string
  carrierId: string
  /** One of the carrier's destinations. */
  destinationId: string
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
  /** Operators work for one or more carriers (chosen per shipment) and see those carriers' shipments. */
  carrierIds?: string[]
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
  /** The route picked (CarrierRoute.id). */
  routeId: string
  /** The route's end address, copied when the shipment is created; the addresses are resolved from it. */
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
  /**
   * Set right before save_waybill and cleared once its answer arrives. If it is still set, an earlier
   * call may have created the waybill without us hearing back, so the next attempt looks it up first.
   */
  rsSaveAttemptedAt?: string
  /** What was sent to RS.ge, fixed when the shipment is created so retries send the same waybill. */
  rsWaybill?: RsWaybillPayload
  /** After upload: the waybill was completed or cancelled on RS.ge (from this app or, via rsRemote, anywhere else). */
  waybillState?: 'closed' | 'cancelled'
  /**
   * The waybill as RS.ge last reported it (background sync or opening the shipment). Where it differs
   * from what was sent (someone corrected the waybill on the rs.ge portal), RS.ge is what counts.
   */
  rsRemote?: RsRemoteWaybill
  rs: { status: StepStatus; error?: string; at?: string }
  sms: {
    status: StepStatus
    error?: string
    at?: string
    to?: string
    text?: string
    /** smsoffice.ge's label for the message (international number + reference ask for its delivery status). */
    destination?: string
    reference?: string
    /** Delivery as smsoffice.ge last reported it; 'ok' above only means it was accepted for sending. */
    delivery?: SmsDelivery
    deliveryCheckedAt?: string
  }
  events: ShipmentEvent[]
}

export type ServiceName = 'RS.ge' | 'SMS'

/** Delivery status of a sent SMS, as smsoffice.ge reports it. */
export type SmsDelivery = 'Pending' | 'Delivered' | 'Undelivered' | 'Expired' | 'Unknown'

/**
 * smsoffice.ge account, set by the admin. The API key never leaves the server: clients get '' plus apiKeySet.
 */
export interface SmsSettings {
  /** API key from smsoffice.ge (profile → integration). Empty in every client copy. */
  apiKey: string
  /** True when a key is stored on the server. Set only in client copies. */
  apiKeySet?: boolean
  /** Sender name registered on smsoffice.ge: up to 11 Latin letters, digits, '-' or '.'. */
  sender: string
  /** Messages left on the account when it was last checked. */
  balance?: number
  checkedAt?: string
}

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
  /**
   * Set on RS.ge read-backs: 'sync' for the background sync, 'page' for opening a shipment.
   * They are kept in their own, smaller part of the log so they never push out the uploads.
   */
  readBack?: 'sync' | 'page'
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

  /** Background sync with RS.ge: changes up to this moment have been read. Cleared with the service user. */
  syncedTo?: string
  /** Why the last background sync failed; cleared by the next successful one. */
  syncError?: string
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

/** A waybill read back from RS.ge (get_waybill). Dates are ISO (UTC). */
export interface RsRemoteWaybill {
  /** 0 saved, 1 active, 2 completed, -1 deleted, -2 cancelled. */
  status: number
  number: string
  buyerTin: string
  buyerName: string
  startAddress: string
  endAddress: string
  driverTin: string
  driverName: string
  carNumber: string
  transportCost: number
  fullAmount: number
  /** Sum of the goods quantities (TOTAL_QUANTITY). */
  quantity: number
  goods: { name: string; unitTxt: string; quantity: number; price: number; amount: number; barCode: string }[]
  comment: string
  activatedAt?: string
  beginAt?: string
  deliveredAt?: string
  closedAt?: string
  /** Set when the waybill was corrected after activation. */
  correctedAt?: string
  /** When RS.ge was asked. */
  checkedAt: string
}

export interface Database {
  version: number
  carriers: Carrier[]
  routes: CarrierRoute[]
  drivers: Driver[]
  trucks: Truck[]
  users: User[]
  shipments: Shipment[]
  logs: IntegrationLog[]
  cargo: CargoDefaults
  rs: RsSettings
  sms: SmsSettings
}
