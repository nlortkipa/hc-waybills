import { buildScalePayload } from '../api/scalePayload'
import { formatKg } from '../lib/util'
import type { Database, Shipment, ShipmentStatus } from '../types'

export const DB_VERSION = 2

export function createSeed(): Database {
  const carriers = [
    { id: 'c1', code: 'C-1001', name: 'კავკასია ლოჯისტიკი', address: 'თბილისი, წერეთლის გამზ. 12' },
    { id: 'c2', code: 'C-1002', name: 'რუსთავი ტრანსი', address: 'რუსთავი, ინდუსტრიული ქ. 7' },
    { id: 'c3', code: 'C-1003', name: 'იმერეთი კარგო', address: 'ქუთაისი, ჭავჭავაძის ქ. 45' },
  ]
  const routes = [
    { id: 'r1', carrierId: 'c1', name: 'SCALE-01', startLocation: 'თბილისის კარიერი', endLocation: 'რუსთავის ქარხანა' },
    { id: 'r2', carrierId: 'c1', name: 'SCALE-02', startLocation: 'თბილისის კარიერი', endLocation: 'მცხეთის საწყობი' },
    { id: 'r3', carrierId: 'c2', name: 'SCALE-03', startLocation: 'რუსთავის ქარხანა', endLocation: 'გარდაბნის ობიექტი' },
    { id: 'r4', carrierId: 'c2', name: 'SCALE-04', startLocation: 'რუსთავის ქარხანა', endLocation: 'მარნეულის საწყობი' },
    { id: 'r5', carrierId: 'c3', name: 'SCALE-05', startLocation: 'ქუთაისის ტერმინალი', endLocation: 'ფოთის პორტი' },
  ]
  const drivers = [
    { id: 'd1', firstName: 'დავით', lastName: 'მაისურაძე', personalId: '01001012345', phone: '+995 555 12 34 56' },
    { id: 'd2', firstName: 'ირაკლი', lastName: 'კვარაცხელია', personalId: '01001023456', phone: '+995 577 23 45 67' },
    { id: 'd3', firstName: 'ზურაბ', lastName: 'წიკლაური', personalId: '01001034567', phone: '+995 599 34 56 78' },
    { id: 'd4', firstName: 'მამუკა', lastName: 'ჩხეიძე', personalId: '01001045678', phone: '+995 551 45 67 89' },
    { id: 'd5', firstName: 'გელა', lastName: 'ჯაფარიძე', personalId: '01001056789', phone: '+995 568 56 78 90' },
  ]
  const trucks = [
    { id: 't1', model: 'Volvo FH16', plateNumber: 'AA-123-BB', trailerNumber: 'TR-456-AA' },
    { id: 't2', model: 'MAN TGS 41.440', plateNumber: 'GE-777-GE', trailerNumber: 'TR-112-GE' },
    { id: 't3', model: 'Scania R450', plateNumber: 'KT-305-KT', trailerNumber: 'TR-908-KT' },
    { id: 't4', model: 'DAF XF 480', plateNumber: 'RS-221-RS', trailerNumber: 'TR-221-RS' },
    { id: 't5', model: 'Mercedes Actros', plateNumber: 'TB-640-TB', trailerNumber: 'TR-640-TB' },
  ]
  const items = [
    { id: 'i1', code: 'CRS-05', description: 'ღორღი 0–5 მმ', whsCode: 'WH-01' },
    { id: 'i2', code: 'GRV-20', description: 'ხრეში 5–20 მმ', whsCode: 'WH-01' },
    { id: 'i3', code: 'SND-01', description: 'მდინარის ქვიშა', whsCode: 'WH-02' },
    { id: 'i4', code: 'CEM-400', description: 'ცემენტი M400 (ნაყარი)', whsCode: 'WH-03' },
  ]
  const users = [
    { id: 'u1', firstName: 'ნინო', lastName: 'ბერიძე', phone: '+995 555 00 00 01', email: 'nino@hc.ge', role: 'admin' as const },
    { id: 'u2', firstName: 'გიორგი', lastName: 'კაპანაძე', phone: '+995 555 00 00 02', email: 'giorgi@kavkasia.ge', role: 'operator' as const, carrierId: 'c1' },
    { id: 'u3', firstName: 'თამარ', lastName: 'ლომიძე', phone: '+995 555 00 00 03', email: 'tamar@rustavitrans.ge', role: 'operator' as const, carrierId: 'c2' },
    { id: 'u4', firstName: 'ანა', lastName: 'გელაშვილი', phone: '+995 555 00 00 04', email: 'ana@imereticargo.ge', role: 'operator' as const, carrierId: 'c3' },
    { id: 'u5', firstName: 'ლევან', lastName: 'კიკნაძე', phone: '+995 555 00 00 05', email: 'levan@hc.ge', role: 'report' as const },
  ]

  const refs = { carriers, routes, drivers, trucks, items }

  // Deterministic pseudo-random so the demo looks the same after every reset.
  let seed = 42
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

  const shipments: Shipment[] = []
  const operatorByCarrier: Record<string, string> = { c1: 'u2', c2: 'u3', c3: 'u4' }
  for (let n = 0; n < 18; n++) {
    const route = routes[Math.floor(rnd() * routes.length)]
    const created = new Date(Date.now() - (n * 9 + 1) * 3600_000 - Math.floor(rnd() * 3000_000))
    const quantity = Math.round((18 + rnd() * 10) * 10) / 10
    const status: ShipmentStatus = n === 0 ? 'at_scale' : n === 5 ? 'rs_failed' : 'weighed'
    const waybill = status === 'rs_failed' ? undefined : String(4100000000 + Math.floor(rnd() * 99999999)).padStart(10, '0')
    const driver = drivers[Math.floor(rnd() * drivers.length)]
    const at = created.toISOString()
    const later = (min: number) => new Date(created.getTime() + min * 60_000).toISOString()
    const s: Shipment = {
      id: `s-seed-${n}`,
      createdAt: at,
      createdBy: operatorByCarrier[route.carrierId],
      carrierId: route.carrierId,
      routeId: route.id,
      driverId: driver.id,
      truckId: trucks[Math.floor(rnd() * trucks.length)].id,
      itemId: items[Math.floor(rnd() * items.length)].id,
      quantity,
      status,
      waybillNumber: waybill,
      rs: status === 'rs_failed' ? { status: 'failed', error: 'RS.ge: მძღოლის პირადი ნომერი არასწორია (კოდი -1012)', at } : { status: 'ok', at },
      sms: status === 'rs_failed' ? { status: 'skipped' } : { status: 'ok', at, to: driver.phone },
      scale: { status: status === 'rs_failed' ? 'skipped' : 'ok' },
      events: [],
    }
    if (waybill) {
      s.scale.payload = buildScalePayload(s, refs)
      s.scale.sentAt = later(1)
      s.events.push(
        { at, level: 'info', message: 'მოთხოვნილია ზედნადების ატვირთვა' },
        { at, level: 'success', message: `RS.ge-მ დააბრუნა ზედნადები №${waybill}` },
        { at, level: 'success', message: `მძღოლს გაეგზავნა SMS (${driver.phone})` },
        { at: later(1), level: 'success', message: 'ზედნადები გაიგზავნა სასწორზე' },
      )
    } else {
      s.events.push(
        { at, level: 'info', message: 'მოთხოვნილია ზედნადების ატვირთვა' },
        { at, level: 'error', message: s.rs.error! },
      )
    }
    if (status === 'weighed') {
      s.scale.weightKg = Math.round(quantity * 1000 * (0.96 + rnd() * 0.08))
      s.scale.weighedAt = later(40 + Math.floor(rnd() * 80))
      s.events.push({ at: s.scale.weighedAt, level: 'success', message: `აიწონა: ${formatKg(s.scale.weightKg)}` })
    }
    shipments.push(s)
  }

  return {
    version: DB_VERSION,
    ...refs,
    users,
    shipments,
    logs: [],
    settings: {
      latencyMs: 900,
      rsFailRate: 0,
      smsFailRate: 0,
      scaleFailRate: 0,
      autoWeigh: true,
      autoWeighDelaySec: 15,
    },
  }
}
