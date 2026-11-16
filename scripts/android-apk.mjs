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

// The app has no server of its own: it calls the HC API server at this address.
// Default: this machine on the local network, port 8787 (what `npm run dev` / `npm run server` listen on).
function lanAddress() {
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
  return ips.find((ip) => /^192\.168\./.test(ip)) ?? ips.find((ip) => /^10\./.test(ip)) ?? ips[0]
}
const apiUrl = process.env.VITE_API_URL ?? (lanAddress() && `http://${lanAddress()}:8787`)
if (!apiUrl) {
  console.error('Could not detect this machine\'s network address. Set VITE_API_URL, e.g. VITE_API_URL=http://192.168.1.10:8787')
  process.exit(1)
}
console.log(`API server for this APK: ${apiUrl}  (override with VITE_API_URL)`)

// HC_NATIVE_BUILD keeps the previous APK out of dist/, which goes inside this APK.
run('npm', ['run', 'build'], root, { ...process.env, HC_NATIVE_BUILD: '1', VITE_API_URL: apiUrl })
run('npx', ['cap', 'sync', 'android'])
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
// dist/ now has VITE_API_URL baked in; rebuild it for the web so the site keeps using its own origin.
run('npm', ['run', 'build'])
console.log(`\n✔ APK ready: ${out}\n  It talks to ${apiUrl} — keep \`npm run dev\` or \`npm run server\` running there.`)
