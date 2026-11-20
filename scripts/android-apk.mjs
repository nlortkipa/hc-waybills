#!/usr/bin/env node
// Builds the web app, syncs it into the Android project and produces an installable
// APK at release/hc-portal-v<version>.apk (debug build, signed with this machine's debug key).
// release/hc-portal.apk always holds the latest one: the website offers it to Android
// phones as /hc-portal.apk (served by `npm run dev`, copied into dist/ by `npm run build`).
// Run from the same machine every time so phones accept it as an update.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const androidDir = join(root, 'android')
const isWin = process.platform === 'win32'
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Gradle needs to know where the Android SDK is. Android Studio installs it to a default
// location but doesn't set ANDROID_HOME, so find it and write android/local.properties (git-ignored).
const localProps = join(androidDir, 'local.properties')
if (!existsSync(localProps) && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  const candidates = [
    join(homedir(), 'Android', 'Sdk'), // Linux
    join(homedir(), 'Library', 'Android', 'sdk'), // macOS
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), // Windows
  ].filter(Boolean)
  const sdk = candidates.find((p) => existsSync(join(p, 'platforms')))
  if (!sdk) {
    console.error('Android SDK not found. Install it via Android Studio (SDK Manager) or set ANDROID_HOME to its path.')
    process.exit(1)
  }
  // Backslashes and colons must be escaped in .properties files (Windows paths).
  writeFileSync(localProps, `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`)
  console.log(`Using Android SDK at ${sdk} (saved to android/local.properties)`)
}

function run(cmd, args, cwd = root, env = process.env) {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: isWin })
  if (r.error || r.status !== 0) process.exit(r.status ?? 1)
}

// The app opens the HC server's website at this address and shows it, so website updates
// reach the app without a new APK. Default: this machine on the local network, port 8787
// (what `npm run server` listens on; it serves the site from dist/).
function lanAddress() {
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
  return ips.find((ip) => /^192\.168\./.test(ip)) ?? ips.find((ip) => /^10\./.test(ip)) ?? ips[0]
}
const appUrl = (process.env.VITE_API_URL ?? (lanAddress() && `http://${lanAddress()}:8787`))?.replace(/\/$/, '')
if (!appUrl) {
  console.error('Could not detect this machine\'s network address. Set VITE_API_URL, e.g. VITE_API_URL=http://192.168.1.10:8787')
  process.exit(1)
}
console.log(`Server for this APK: ${appUrl}  (override with VITE_API_URL)`)

// HC_NATIVE_BUILD keeps the previous APK out of dist/, which goes inside this APK.
// The page the app shows comes from the server (same origin as the API), so no VITE_API_URL here.
const { VITE_API_URL: _, ...webEnv } = process.env
run('npm', ['run', 'build'], root, { ...webEnv, HC_NATIVE_BUILD: '1' })
// Shown by the app when the server can't be reached; retries until it can.
writeFileSync(join(root, 'dist', 'offline.html'), offlinePage(appUrl))
run('npx', ['cap', 'sync', 'android'], root, { ...process.env, HC_APP_URL: appUrl })
run(isWin ? 'gradlew.bat' : './gradlew', ['assembleDebug'], androidDir)

const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
if (!existsSync(apk)) {
  console.error(`Build finished but ${apk} was not found.`)
  process.exit(1)
}
mkdirSync(join(root, 'release'), { recursive: true })
const out = join(root, 'release', `hc-portal-v${version}.apk`)
copyFileSync(apk, out)
copyFileSync(apk, join(root, 'release', 'hc-portal.apk'))
// Rebuild dist/ for the web so it also offers the new APK (and drops offline.html).
run('npm', ['run', 'build'])
console.log(`\n✔ APK ready: ${out}\n  It opens ${appUrl}: keep \`npm run server\` running there. Website updates (\`npm run build\`) reach the app on its next start.`)

function offlinePage(url) {
  return `<!doctype html>
<html lang="ka">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HC Portal</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f2f2f7; color: #1c1c1e; text-align: center; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #f2f2f7; } }
  main { padding: 24px; max-width: 320px; }
  p { color: #8e8e93; }
  button { font: inherit; padding: 12px 24px; border: 0; border-radius: 12px; background: #007aff; color: #fff; }
</style>
</head>
<body>
<main>
  <h2>სერვერთან კავშირი ვერ დამყარდა</h2>
  <p>შეამოწმეთ ინტერნეტი. ვცდილობთ თავიდან…</p>
  <button onclick="go()">თავიდან ცდა</button>
</main>
<script>
  const url = ${JSON.stringify(url + '/')}
  function go() { location.replace(url) }
  setInterval(() => fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(go, () => {}), 5000)
</script>
</body>
</html>
`
}
