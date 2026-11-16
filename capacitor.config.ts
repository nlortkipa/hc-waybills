import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'ge.hc.portal',
  appName: 'HC Portal',
  webDir: 'dist',
  server: {
    // Serve the app as http://localhost so it may call the API over plain HTTP on the LAN
    // (an https:// origin would block those requests as mixed content).
    androidScheme: 'http',
  },
}

export default config
