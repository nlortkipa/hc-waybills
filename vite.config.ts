import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the build works inside the Android WebView (Capacitor).
  base: './',
  plugins: [react(), tailwindcss()],
  server: { host: true },
})
