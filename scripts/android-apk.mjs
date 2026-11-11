#!/usr/bin/env node
// Builds the web app, syncs it into the Android project and produces an installable
// APK at release/hc-portal-v<version>.apk (debug build, signed with this machine's debug key).
// Run from the same machine every time so phones accept it as an update.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

function run(cmd, args, cwd = root) {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin })
  if (r.error || r.status !== 0) process.exit(r.status ?? 1)
}

run('npm', ['run', 'build'])
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
console.log(`\n✔ APK ready: ${out}`)
