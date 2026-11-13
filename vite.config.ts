import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the build works inside the Android WebView (Capacitor).
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    // The vendor Scale API's CORS policy allows any origin but no request headers,
    // so browsers can't send it Authorization/JSON. In dev the app calls it
    // same-origin through this proxy instead.
    proxy: {
      '/scale-api': {
        target: process.env.SCALE_API_PROXY_TARGET ?? 'http://localhost:5080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/scale-api/, ''),
      },
    },
  },
})
