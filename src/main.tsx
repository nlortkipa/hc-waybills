import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans-georgian'
import './index.css'
import App from './App.tsx'

if (Capacitor.isNativePlatform()) {
  // Match the iOS-style grouped background in both appearances.
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    StatusBar.setStyle({ style: dark.matches ? Style.Dark : Style.Light }).catch(() => {})
    StatusBar.setBackgroundColor({ color: dark.matches ? '#000000' : '#f2f2f7' }).catch(() => {})
  }
  apply()
  dark.addEventListener('change', apply)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
