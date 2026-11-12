import { resolveRoute } from '../lib/route'
import type { Database, ScalePayload, Shipment } from '../types'

/**
 * Maps a shipment to the payload the client's Scale Service expects.
 * Field mapping is our best interpretation of the client spec — confirm with the client:
 *   docEntry      = RS.ge waybill number (same as the order number)
 *   cardCode/Name = carrier code / name
 *   u_ShipToCodeS = destination scale ID
 *   shipToCode    = destination (end) address
 *   u_TruckNum(2) = plate / trailer number, u_Truck = truck model
 *   itemCode/description/whsCode = cargo item, quantity = declared tonnes
 */
export function buildScalePayload(s: Shipment, db: Pick<Database, 'carriers' | 'drivers' | 'trucks' | 'items'>): ScalePayload {
  const carrier = db.carriers.find((c) => c.id === s.carrierId)
  const route = resolveRoute(db.carriers, s.carrierId, s.destinationId)
  const driver = db.drivers.find((d) => d.id === s.driverId)
  const truck = db.trucks.find((t) => t.id === s.truckId)
  const item = db.items.find((i) => i.id === s.itemId)
  return {
    actionFlag: 's',
    processType: 's',
    docEntry: s.waybillNumber ?? '',
    docDate: s.createdAt,
    cardCode: carrier?.code ?? '',
    cardName: carrier?.name ?? '',
    u_ShipToCodeS: route.scaleId,
    shipToCode: route.end,
    u_DriverName: driver ? `${driver.firstName} ${driver.lastName}` : '',
    u_TruckNum: truck?.plateNumber ?? '',
    u_TruckNum2: truck?.trailerNumber ?? '',
    u_Truck: truck?.model ?? '',
    itemCode: item?.code ?? '',
    description: item?.description ?? '',
    quantity: s.quantity,
    whsCode: item?.whsCode ?? '',
  }
}
