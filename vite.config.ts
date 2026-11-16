import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** Latest APK from `npm run android:apk`, served to phones as /hc-portal.apk. */
const APK = join(import.meta.dirname, 'release', 'hc-portal.apk')
const APK_NAME = 'hc-portal.apk'

function serveApk(): Plugin {
  let outDir = 'dist'
  return {
    name: 'hc-serve-apk',
    configResolved(c) {
      outDir = c.build.outDir
    },
    configureServer(server) {
      server.middlewares.use(`/${APK_NAME}`, (_req, res, next) => {
        if (!existsSync(APK)) return next()
        res.setHeader('Content-Type', 'application/vnd.android.package-archive')
        res.setHeader('Content-Length', statSync(APK).size)
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(APK).pipe(res)
      })
    },
    closeBundle() {
      // The Android build bundles dist/ into the APK itself, so leave the APK out there.
      if (process.env.HC_NATIVE_BUILD || !existsSync(APK)) return
      copyFileSync(APK, join(outDir, APK_NAME))
    },
  }
}

export default defineConfig({
  // Relative base so the build works inside the Android WebView (Capacitor).
  base: './',
  plugins: [react(), tailwindcss(), serveApk()],
  server: {
    host: true,
  },
})
