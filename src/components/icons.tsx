import { PackageCheck, Truck, Undo2, Warehouse } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WaybillType } from '../types'

/** The icon of each waybill type, wherever a type is picked. */
export const WAYBILL_TYPE_ICON: Record<WaybillType, ReactNode> = { 1: <Warehouse />, 2: <Truck />, 3: <PackageCheck />, 5: <Undo2 /> }
