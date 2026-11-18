export type Role = 'admin' | 'operator' | 'report'

/**
 * Reference records referenced by shipments are never hard-deleted: they get a
 * deletedAt stamp, disappear from lists and pickers, but still resolve in history.
 */
export interface SoftDeletable {
  deletedAt?: string
}

export interface Carrier extends SoftDeletable {
  id: string
  name: string
  /** The single place every shipment of this carrier starts from. */
  startAddress: string
}

/**
 * A route the admin opened for a carrier: the carrier's start address → the end address typed here,
 * with the goods lines carried on it. Operators pick one of these for each shipment and type each
 * line's quantity (dropping the lines the truck doesn't carry).
 */
export interface CarrierRoute extends SoftDeletable {
  id: string
  carrierId: string
  endAddress: string
  /** ID of the scale at the end address. */
  scaleId: string
  /** The goods lines of this route's waybills, at least one (none on old routes not set up yet). */
  goods: RouteGood[]
}

/**
 * One goods line of a route, set up by the admin: bar code, name and unit typed in or filled from the
 * RS.ge product list (and then still editable; nothing is added to RS.ge's list), plus what RS.ge needs
 * besides the quantity, which the operator types on each shipment. Sent exactly as written here.
 */
export interface RouteGood {
  id: string
  /** The list product it was filled from, while the bar code is still that product's; '' otherwise. */
  productId: string
  /** W_NAME. */
  name: string
  /** BAR_CODE. */
  barCode: string
  /** UNIT_ID; 99 = "other", then unitTxt is the unit name. */
  unitId: number
  unitTxt: string
  /** PRICE: per unit, GEL. AMOUNT = quantity × price. */
  price: number
  /** VAT_TYPE: 0 ordinary, 1 zero-rated, 2 exempt. */
  vatType: 0 | 1 | 2
  /** A_ID: the excise code (RsAkciz.id) of excise goods; 0 or missing = not excise goods. */
  aId?: number
  /** The excise code as shown, e.g. "2207 · ეთილის სპირტი(2207)_ლიტრი _ (2.6)". */
  aTitle?: string
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

/**
 * A product (საქონელი): a copy of one entry of the connected taxpayer's RS.ge product list
 * (get_bar_codes / save_bar_code), kept equal to it by the sync. The bar code is its identity on
 * RS.ge, so it can't be changed once saved. Price and VAT type are kept here only (RS.ge's list has
 * no such fields). Picking a product for a route's goods line fills the line with all of it.
 */
export interface Product extends SoftDeletable {
  id: string
  /** W_NAME / goods_name. */
  name: string
  /** Bar code (სასაქონლო კოდი): BAR_CODE on the waybill. */
  barCode: string
  /** UNIT_ID from get_waybill_units; 99 = "other", then unitTxt is the unit name. */
  unitId: number
  unitTxt: string
  /** A_ID: excise code (RsAkciz.id) on RS.ge; 0 or missing = not excise goods. */
  aId?: number
  /** Price per unit, GEL, for goods lines filled from this product. Not on RS.ge; missing = not set. */
  price?: number
  /** VAT_TYPE for goods lines filled from this product. Not on RS.ge; missing = 0 (ordinary). */
  vatType?: 0 | 1 | 2
}

/**
 * One goods line of a shipment's waybill: a route goods line (lineId) with the quantity the operator
 * typed. The rest is a snapshot of the line, refreshed when the waybill is saved.
 */
export interface ShipmentItem extends Omit<RouteGood, 'id'> {
  /** RouteGood.id; '' on shipments from before route goods lines existed. */
  lineId: string
  quantity: number
  /** QUANTITY_EXT: the optional additional quantity (დამატებითი რაოდენობა). */
  quantityExt?: number
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
  /** The route picked (CarrierRoute.id); the addresses are resolved from it. */
  routeId: string
  driverId: string
  truckId: string
  /** The waybill's goods lines, at least one. */
  items: ShipmentItem[]
  /** Declared quantity: the sum of the items' quantities. */
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

/** An excise goods code from RS.ge (get_akciz_codes). */
export interface RsAkciz {
  id: number
  title: string
  /** Unit of measure, e.g. ლიტრი. */
  unit: string
  /** SAKON_KODI: the goods code. */
  code: string
  /** AKCIS_GANAKV: the excise rate. */
  rate: string
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
  /**
   * Buyer of every waybill. Empty (or the seller's own number): შიდა გადაზიდვა, the buyer is the seller.
   * Any other number: მიწოდება ტრანსპორტირებით. The name is RS.ge's when RS.ge knows the number
   * (`buyerForeign` false), else typed by the admin and sent unchecked (`buyerForeign` true).
   */
  buyerTin: string
  buyerName: string
  buyerForeign: boolean
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

  /** Quantity prefilled on each goods line of a new shipment (the operator can change it); 0 = none. */
  quantity: number

  receptionInfo: string
  receiverInfo: string
  /** Extra COMMENT text. The trailer number is always added to the comment. */
  comment: string

  /** Reference lists cached from RS.ge by "check connection". */
  units: RsRefItem[]
  transTypes: RsRefItem[]
  /** Excise goods codes, for goods lines of excise goods. Missing until first loaded. */
  akciz?: RsAkciz[]

  /** Background sync with RS.ge: changes up to this moment have been read. Cleared with the service user. */
  syncedTo?: string
  /** Why the last background sync failed; cleared by the next successful one. */
  syncError?: string
  /** Products last read from RS.ge (get_bar_codes) at this time, and why the last read failed. */
  productsSyncedAt?: string
  productsSyncError?: string
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
    /** A_ID; 0 or missing = not excise goods. */
    aId?: number
    /** QUANTITY_EXT; sent only when set. */
    quantityExt?: number
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
  products: Product[]
  users: User[]
  shipments: Shipment[]
  logs: IntegrationLog[]
  rs: RsSettings
  sms: SmsSettings
}
