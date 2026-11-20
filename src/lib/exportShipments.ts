import { statusMeta } from '../components/ui'
import type { Shipment } from '../types'
import type { Lookup } from './lookup'
import { shipmentQuantity } from './rs'
import { tbilisiStamp } from './util'
import { downloadXlsx } from './xlsx'

/** Shipments as an Excel sheet: the same columns from the list and the reports. */
export function exportShipments(filename: string, rows: Shipment[], L: Lookup) {
  return downloadXlsx(filename, [
    ['ზედნადები', 'შექმნის დრო', 'კარიერი', 'მარშრუტი', 'მძღოლი', 'მანქანის ნომერი', 'ტვირთი', 'დეკლარირებული (ტ)', 'SMS', 'სტატუსი'],
    ...rows.map((s) => {
      const x = L.describe(s)
      return [
        s.waybillNumber ?? '',
        tbilisiStamp(s.createdAt),
        x.carrier,
        x.route,
        x.driver,
        x.plate,
        x.item,
        shipmentQuantity(s),
        s.sms.status === 'ok' ? 'გაგზავნილი' : s.sms.status === 'failed' ? 'შეცდომა' : '',
        s.waybillState === 'cancelled' ? 'გაუქმებული' : s.waybillState === 'closed' ? 'დასრულებული' : statusMeta[s.status].label,
      ]
    }),
  ], 'რეისები')
}
