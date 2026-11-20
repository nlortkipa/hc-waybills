import type { CapacitorConfig } from '@capacitor/cli'

// The app is a shell around the website: it opens the HC server's address (set by
// scripts/android-apk.mjs at build time) and shows whatever the server serves from dist/.
// So a website update (`npm run build` on the server) reaches the app on its next start,
// with no new APK. If the server can't be reached, the bundled offline.html retries.
const url = process.env.HC_APP_URL

const config: CapacitorConfig = {
  appId: 'ge.hc.portal',
  appName: 'HC Portal',
  webDir: 'dist',
  server: url
    ? { url, cleartext: url.startsWith('http://'), errorPath: 'offline.html' }
    : // No address: serve the bundled copy as http://localhost so it may call the API over plain HTTP.
      { androidScheme: 'http' },
}

export default config
