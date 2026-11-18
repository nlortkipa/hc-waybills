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
  /** Waybill type for shipments on this route; missing = from the RS.ge settings (buyer set → 2, else 1). */
  waybillType?: WaybillType
  /**
   * Buyer for shipments on this route; empty = the one in the RS.ge settings. Resolved like the
   * settings' buyer: RS.ge's name when it knows the number (buyerForeign false), else the typed name.
   */
  buyerTin?: string
  buyerName?: string
  buyerForeign?: boolean
}

/**
 * RS.ge waybill types this app writes: 1 შიდა გადაზიდვა, 2 მიწოდება ტრანსპორტირებით,
 * 3 მიწოდება ტრანსპორტირების გარეშე, 5 უკან დაბრუნება. (4 დისტრიბუცია and 6 ქვე-ზედნადები are
 * not used: a truck trip here is always one waybill.)
 */
export type WaybillType = 1 | 2 | 3 | 5

/**
 * What a shipment's waybill says beyond the route, driver, truck and goods: chosen on the shipment
 * (prefilled from the route, then from the RS.ge settings) and kept, so retries and corrections send the same.
 */
export interface ShipmentWaybill {
  type: WaybillType
  /** Empty for type 1: the buyer is then the seller. */
  buyerTin: string
  buyerName: string
  buyerForeign: boolean
  /** Planned start of transport (ISO). Missing = when it is activated. RS.ge allows up to 3 days ahead. */
  beginAt?: string
  transportCost: number
  tranCostPayer: 1 | 2
  receptionInfo: string
  receiverInfo: string
  /** Comment typed for this shipment; the trailer number and the HC tag are added to it. */
  comment: string
}

/**
 * One goods line of a route, set up by the admin: bar code, name and unit typed in or filled from the
 * RS.ge product list (and then still editable; nothing is added to RS.ge's list), plus what RS.ge needs
 * besides the quantity, which the operator types on each shipment. Sent exactly as written here.
 */
export interface RouteGood {
  id: string
  /** The RS.ge product (its bar code) it was filled from, while the bar code is still that; '' otherwise. */
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

/**
 * A truck. Its plate number lives in the taxpayer's car-number list on RS.ge (get_car_numbers); only
 * what RS.ge has no place for (model, trailer) is stored here, keyed to the plate. In the view, every
 * plate on RS.ge is a truck: one without a record here has the id `rs-<PLATE>` and empty extras (the
 * record is made when a shipment first uses it). A record whose plate is gone from RS.ge is shown as
 * deleted. While RS.ge's list can't be read, the records here are shown as they are.
 */
export interface Truck extends SoftDeletable {
  id: string
  model: string
  plateNumber: string
  trailerNumber: string
}

/**
 * A product (საქონელი): one entry of the connected taxpayer's RS.ge product list (get_bar_codes /
 * save_bar_code), read from RS.ge and never stored here. The bar code is its identity on RS.ge (and
 * its id here), so it can't be changed once saved. Picking a product for a route's goods line fills
 * the line with it; the line's price and VAT type are typed on the route.
 */
export interface Product extends SoftDeletable {
  /** = barCode. */
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
}

/**
 * One goods line of a shipment's waybill: a route goods line (lineId) with the quantity the operator
 * typed. The rest is a snapshot of the line, refreshed when the waybill is saved. Once the waybill is
 * on RS.ge, the lines are RS.ge's goods rows (matched to the route's lines by bar code).
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
  | 'saved' // saved on RS.ge as a draft, not activated yet (no number)
  | 'uploaded' // waybill number received

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'

export interface ShipmentEvent {
  at: string
  level: 'info' | 'success' | 'error'
  message: string
}

/**
 * A shipment (რეისი). Stored here is only what RS.ge doesn't know: who made it for which carrier,
 * route, driver and truck, the RS.ge waybill ID, the driver's SMS and the history. What the operator
 * typed (goods, quantities, waybill options) is stored only until the waybill is on RS.ge; after that
 * RS.ge has it, and the server fills those fields from RS.ge in every view (see server/rscache.ts),
 * along with the fields marked "from RS.ge". They are missing while RS.ge's copy can't be read.
 */
export interface Shipment {
  id: string
  createdAt: string
  createdBy: string
  carrierId: string
  /** The route picked (CarrierRoute.id); the addresses are resolved from it. */
  routeId: string
  /** '' for a waybill without transport (type 3). */
  driverId: string
  /** '' for a waybill without transport (type 3). */
  truckId: string
  /** Type, buyer, start time and transport details. Stored until the waybill is on RS.ge, then from RS.ge. */
  waybill?: ShipmentWaybill
  /** Save on RS.ge without activating (შენახვა); cleared when it is activated. */
  draft?: boolean
  /** From RS.ge: tax invoice (ანგარიშ-ფაქტურა) written from this waybill. */
  invoiceId?: number
  /** The waybill's goods lines, at least one. Stored until the waybill is on RS.ge, then from RS.ge ([] while it can't be read). */
  items: ShipmentItem[]
  /** The sum of the items' quantities. Stored until the waybill is on RS.ge, then from RS.ge. */
  quantity: number
  status: ShipmentStatus
  /** The number RS.ge gave the waybill on activation. Stored: it never changes, and the SMS and history name it. */
  waybillNumber?: string
  /** RS.ge internal waybill ID returned by save_waybill. Kept so retries activate it instead of creating a duplicate. */
  rsWaybillId?: number
  /**
   * Set right before save_waybill and cleared once its answer arrives. If it is still set, an earlier
   * call may have created the waybill without us hearing back, so the next attempt looks it up first.
   */
  rsSaveAttemptedAt?: string
  /** What is sent to RS.ge; stored only until RS.ge has the waybill. */
  rsWaybill?: RsWaybillPayload
  /** From RS.ge: the waybill was completed or cancelled (from this app or the rs.ge portal). */
  waybillState?: 'closed' | 'cancelled'
  /** From RS.ge: the waybill as RS.ge has it now (read on demand, kept in the server's memory). */
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

/** One row of RS.ge's waybill lists (get_waybills: issued, get_buyer_waybills: received). Dates ISO (UTC). */
export interface RsListWaybill {
  id: number
  type: number
  status: number
  number: string
  createdAt?: string
  activatedAt?: string
  beginAt?: string
  closedAt?: string
  deliveredAt?: string
  buyerTin: string
  buyerName: string
  sellerTin: string
  sellerName: string
  startAddress: string
  endAddress: string
  driverTin: string
  driverName: string
  carNumber: string
  fullAmount: number
  comment: string
  /** Buyer's answer: 0 none, 1 confirmed (მივიღე), -1 rejected (არ ვეთანხმები). */
  confirmed: number
  corrected: boolean
  /** The HC shipment this waybill belongs to, when it is one of ours (and the caller may see it). */
  shipmentId?: string
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
 * Fields marked "from RS.ge" are never stored: the server reads them from RS.ge and adds them to each view.
 */
export interface RsSettings {
  /** Service user (სერვისის მომხმარებელი). */
  su: string
  /** Service user password. Empty in every client copy. */
  sp: string
  /** True when a password is stored on the server. Set only in client copies. */
  spSet?: boolean

  /* From RS.ge — the seller: the taxpayer that owns the service user. */
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
  /** From RS.ge: when the seller was read. */
  checkedAt?: string
  /** From RS.ge: why the seller couldn't be read (RS.ge unreachable, password changed…). */
  accountError?: string

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

  /** From RS.ge: reference lists. */
  units: RsRefItem[]
  transTypes: RsRefItem[]
  /** Excise goods codes, for goods lines of excise goods. Missing until first loaded. */
  akciz?: RsAkciz[]

  /** From RS.ge: waybills changed up to this moment have been re-read, and why the last check failed. */
  syncedTo?: string
  syncError?: string
  /** From RS.ge: the product list (get_bar_codes) was read at this time, and why the last read failed. */
  productsSyncedAt?: string
  productsSyncError?: string
  /** From RS.ge: the car-number list (get_car_numbers) was read at this time, and why the last read failed. */
  platesReadAt?: string
  platesError?: string
}

/** RsSettings fields that come from RS.ge and are never stored. */
export const RS_LIVE_FIELDS = [
  'sellerUnId',
  'sellerUserId',
  'sellerTin',
  'sellerName',
  'checkedAt',
  'accountError',
  'units',
  'transTypes',
  'akciz',
  'syncedTo',
  'syncError',
  'productsSyncedAt',
  'productsSyncError',
  'platesReadAt',
  'platesError',
  'spSet',
] as const

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

/** A goods row of a waybill read back from RS.ge. */
export interface RsRemoteGood {
  /** Row ID on RS.ge: a correction updates the row with this ID. Missing on old snapshots. */
  id?: number
  name: string
  unitId?: number
  unitTxt: string
  quantity: number
  quantityExt?: number
  price: number
  amount: number
  barCode: string
  vatType?: number
  aId?: number
}

/** A waybill read back from RS.ge (get_waybill). Dates are ISO (UTC). */
export interface RsRemoteWaybill {
  /** RS.ge waybill ID. Missing on snapshots taken before it was kept. */
  id?: number
  /** Waybill type (1–6). Missing on old snapshots. */
  type?: number
  /** 0 saved, 1 active, 2 completed, 8 sent to the transporter, -1 deleted, -2 cancelled. */
  status: number
  number: string
  buyerTin: string
  buyerName: string
  /** CHEK_BUYER_TIN 0: a foreign buyer. */
  buyerForeign?: boolean
  startAddress: string
  endAddress: string
  driverTin: string
  driverName: string
  carNumber: string
  transportCost: number
  fullAmount: number
  /** Sum of the goods quantities (TOTAL_QUANTITY). */
  quantity: number
  goods: RsRemoteGood[]
  comment: string
  /* Missing on snapshots taken before they were kept. */
  sellerTin?: string
  sellerName?: string
  transId?: number
  transTxt?: string
  tranCostPayer?: number
  transporterTin?: string
  receptionInfo?: string
  receiverInfo?: string
  /** The amount in words, as RS.ge prints it. */
  fullAmountText?: string
  invoiceId?: number
  /** Buyer's answer: 0 none, 1 confirmed, -1 rejected. */
  confirmed?: number
  createdAt?: string
  activatedAt?: string
  beginAt?: string
  deliveredAt?: string
  closedAt?: string
  /** Set when the waybill was corrected after activation. */
  correctedAt?: string
  /** When RS.ge was asked. */
  checkedAt: string
}

/** What a client sees: the stored data plus what is read from RS.ge (products, plates, waybills, account). */
export interface Database {
  version: number
  carriers: Carrier[]
  routes: CarrierRoute[]
  drivers: Driver[]
  trucks: Truck[]
  /** From RS.ge. */
  products: Product[]
  users: User[]
  shipments: Shipment[]
  logs: IntegrationLog[]
  rs: RsSettings
  sms: SmsSettings
}

/** What the server stores. Products are RS.ge's only. */
export type StoredDatabase = Omit<Database, 'products'>
