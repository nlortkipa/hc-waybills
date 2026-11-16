import { useEffect, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { shipments } from './api'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/toast'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'
import { MockConsole } from './pages/MockConsole'
import { NewShipment } from './pages/NewShipment'
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
  const { user } = useSession()
  if (!user) return <Login />
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Guard roles={['admin', 'operator']}><Dashboard /></Guard>} />
        <Route path="/new" element={<Guard roles={['admin', 'operator']}><NewShipment /></Guard>} />
        <Route path="/shipments" element={<Shipments />} />
        <Route path="/shipments/:id" element={<ShipmentDetail />} />
        <Route path="/reports" element={<Guard roles={['admin', 'report']}><Reports /></Guard>} />
        <Route path="/refs" element={<Guard roles={['admin']}><ReferenceData /></Guard>} />
        <Route path="/mock" element={<MockConsole />} />
        <Route path="*" element={<Navigate to={home[user.role]} replace />} />
      </Routes>
    </Layout>
  )
}

export default function App() {
  useEffect(() => shipments.resumeAll(), [])
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
