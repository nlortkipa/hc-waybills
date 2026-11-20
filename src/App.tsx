import type { ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/toast'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'
import { ApiLog } from './pages/ApiLog'
import { EditShipment, NewShipment } from './pages/NewShipment'
import { PrintWaybill } from './pages/PrintWaybill'
import { RsWaybills } from './pages/RsWaybills'
import { ReferenceData } from './pages/ReferenceData'
import { Reports } from './pages/Reports'
import { ShipmentDetail } from './pages/ShipmentDetail'
import { Shipments } from './pages/Shipments'
import { SessionProvider, useSession } from './session'
import type { Role } from './types'

const home: Record<Role, string> = { admin: '/', operator: '/', report: '/reports' }

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useSession()
  if (!user) return null
  return roles.includes(user.role) ? children : <Navigate to={home[user.role]} replace />
}

function AppRoutes() {
  const { user, restoring } = useSession()
  const { pathname } = useLocation()
  if (restoring) return null
  if (!user) return <Login />
  // A waybill on paper: no app chrome around it.
  if (pathname.startsWith('/print/'))
    return (
      <Routes>
        <Route path="/print/:id" element={<PrintWaybill />} />
      </Routes>
    )
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Guard roles={['admin', 'operator']}><Dashboard /></Guard>} />
        <Route path="/new" element={<Guard roles={['admin', 'operator']}><NewShipment /></Guard>} />
        <Route path="/shipments" element={<Shipments />} />
        <Route path="/shipments/:id" element={<ShipmentDetail />} />
        <Route path="/shipments/:id/edit" element={<Guard roles={['admin', 'operator']}><EditShipment /></Guard>} />
        <Route path="/waybills" element={<Guard roles={['admin', 'report']}><RsWaybills /></Guard>} />
        <Route path="/reports" element={<Guard roles={['admin', 'report']}><Reports /></Guard>} />
        <Route path="/refs" element={<Guard roles={['admin']}><ReferenceData /></Guard>} />
        <Route path="/logs" element={<ApiLog />} />
        <Route path="*" element={<Navigate to={home[user.role]} replace />} />
      </Routes>
    </Layout>
  )
}

export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <SessionProvider>
          <AppRoutes />
        </SessionProvider>
      </ToastProvider>
    </HashRouter>
  )
}
