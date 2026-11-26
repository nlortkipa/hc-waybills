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
 * with everything its waybills carry: the goods lines (quantities included) and the transport details.
 * Operators only pick a route, a driver and a truck; the waybill is always შიდა გადაზიდვა.
 */
export interface CarrierRoute extends SoftDeletable, RouteWaybill {
  id: string
  carrierId: string
  endAddress: string
  /** The route's scale: a Scale record's id (its ID at the scale is Scale.code). */
  scaleId: string
  /** The goods lines of this route's waybills, sent as written. Empty on routes not set up yet (they can't be picked). */
  goods: RouteGood[]
}

/**
 * A scale (სასწორი): a weighing service the admin registered, with its ID there (the factory code
 * the scale knows, sent as whsCode) and the address of its API. Each route picks one; shipments go to
 * the API of their route's scale (docs/scale-api.md).
 */
export interface Scale extends SoftDeletable {
  id: string
  /** The scale's ID (its factory code, e.g. GE11). */
  code: string
  /** Its API's address, e.g. http://kc00001:5000. */
  url: string
}

/** A goods line of a route: what one goods row of its waybills says, quantity included. */
export type RouteGood = ShipmentItem

/**
 * What a route's waybills carry beyond the goods; missing = empty. The transport type is always
 * საავტომობილო (src/lib/rs.ts), with the seller paying the transport cost.
 */
export interface RouteWaybill {
  transportCost?: number
  comment?: string
}

/**
 * RS.ge waybill types: 1 შიდა გადაზიდვა (the only one this app writes now), 2 ტრანსპორტირებით,
 * 3 ტრანსპორტირების გარეშე, 5 უკან დაბრუნება (older shipments and waybills read from RS.ge).
 */
export type WaybillType = 1 | 2 | 3 | 5

/**
 * What a shipment's waybill says beyond the route, driver, truck and goods: taken from the route when
 * the shipment is made and kept, so retries and corrections send the same.
 */
export interface ShipmentWaybill {
  type: WaybillType
  /** Empty for type 1: the buyer is then the seller. */
  buyerTin: string
  buyerName: string
  buyerForeign: boolean
  /** Planned start of transport (ISO). Missing = when it is activated. RS.ge allows up to 3 days ahead. */
  beginAt?: string
  /** The transport type is always საავტომობილო (RS_TRANS_CAR), paid by the seller. */
  transportCost: number
  receptionInfo: string
  receiverInfo: string
  /** Comment typed for this shipment; the trailer number and the HC tag are added to it. */
  comment: string
}

/**
 * One goods line of a waybill, as the admin writes it on the route: bar code, name and unit typed in
 * or filled from the RS.ge product list (and then still editable; nothing is added to RS.ge's list),
 * price, VAT type and quantity. A shipment takes its route's lines when it is made; they are stored
 * until the waybill is on RS.ge, then RS.ge's goods rows.
 */
export interface ShipmentItem {
  /** W_NAME. */
  name: string
  /** BAR_CODE. */
  barCode: string
  /** UNIT_ID; 99 = "other", then unitTxt is the unit name. */
  unitId: number
  unitTxt: string
  /** PRICE: per unit, GEL. */
  price: number
  /** AMOUNT (საქონლის ფასი): the line total typed in by hand; missing = quantity × price (see itemAmount). */
  amount?: number
  /** VAT_TYPE: 0 ordinary, 1 zero-rated, 2 exempt. */
  vatType: 0 | 1 | 2
  /** A_ID: the excise code (RsAkciz.id) of excise goods; 0 or missing = not excise goods. */
  aId?: number
  /** The excise code as shown, e.g. "2207 · ეთილის სპირტი(2207)_ლიტრი _ (2.6)". */
  aTitle?: string
  quantity: number
  /** QUANTITY_EXT: the optional additional quantity (დამატებითი რაოდენობა). */
  quantityExt?: number
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
 * save_bar_code), read from RS.ge. The bar code is its identity on RS.ge (and its id here), so it
 * can't be changed once saved. The unit price and VAT type, which RS.ge's API doesn't carry, are
 * stored here by bar code. Picking a product for a route's goods line fills the line with it.
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
  /** A_ID: excise code (RsAkciz.id) on RS.ge; 0 or missing = not excise goods. Not edited here: kept as RS.ge has it. */
  aId?: number
  /** Unit price, GEL (stored here). */
  price?: number
  /** VAT type: 0 ჩვეულებრივი, 1 ნულოვანი, 2 დაუბეგრავი (stored here). */
  vatType?: 0 | 1 | 2
}

export interface User extends SoftDeletable {
  id: string
  firstName: string
  lastName: string
  phone: string
  email: string
  role: Role
  /** Operators work for one or more carriers (their routes are the ones they can pick) and see those carriers' shipments. */
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
 * route, driver and truck, the RS.ge waybill ID, the driver's SMS and the history. What came from the
 * route (goods, quantities, waybill options) is stored only until the waybill is on RS.ge; after that
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
  /** '' on older waybills without transport (type 3). */
  driverId: string
  /** '' on older waybills without transport (type 3). */
  truckId: string
  /** Type, buyer, start time and transport details, from the route. Stored until the waybill is on RS.ge, then from RS.ge. */
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
  /**
   * The shipment at the scale (სასწორი, docs/scale-api.md): sent with the estimated weight once RS.ge
   * numbered the waybill, to the API of its route's scale; the scale reports the real weight after
   * weighing the truck. Missing on shipments made before scales were connected.
   */
  scale?: ScaleState
  events: ShipmentEvent[]
}

export interface ScaleState {
  /** Sending the order: 'skipped' = nothing to send (no transport, or the route has no scale ID). */
  status: StepStatus
  error?: string
  at?: string
  /** What the last order sent did: I added it, U changed it, D removed it (the waybill was cancelled). */
  action?: 'I' | 'U' | 'D'
  /** The scale (Scale.id) the last order went to: a later U or D goes there. */
  scaleId?: string
  /** Estimated weight sent (the waybill's quantity, tonnes). */
  estimated?: number
  /** The real weight the scale reported, as it sends it (a whole number: kilograms). */
  weight?: number
  weighedAt?: string
}

export type ServiceName = 'RS.ge' | 'SMS' | 'Scale'

/** Delivery status of a sent SMS, as smsoffice.ge reports it. */
export type SmsDelivery = 'Pending' | 'Delivered' | 'Undelivered' | 'Expired' | 'Unknown'

/**
 * smsoffice.ge account. The API key and sender are in the server's .env and the key never leaves the server.
 */
export interface SmsSettings {
  /** Sender name registered on smsoffice.ge (SMSOFFICE_SENDER in .env). Filled in by the server's view only. */
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
 * RS.ge connection: the service user, from the server's .env. Everything else on a waybill comes from its route.
 * The password never leaves the server.
 * Fields marked "from RS.ge" are never stored: the server reads them from RS.ge and adds them to each view.
 */
export interface RsSettings {
  /** Service user (სერვისის მომხმარებელი, RS_SERVICE_USER in .env). Admins only; never stored. */
  su: string

  /* From RS.ge — the seller: the taxpayer that owns the service user. */
  sellerUnId: number | null
  sellerUserId: number | null
  sellerTin: string
  sellerName: string
  /** From RS.ge: when the seller was read. */
  checkedAt?: string
  /** From RS.ge: why the seller couldn't be read (RS.ge unreachable, password changed…). */
  accountError?: string

  /** From RS.ge: reference lists. */
  units: RsRefItem[]
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
  'akciz',
  'syncedTo',
  'syncError',
  'productsSyncedAt',
  'productsSyncError',
  'platesReadAt',
  'platesError',
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
  scales: Scale[]
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
