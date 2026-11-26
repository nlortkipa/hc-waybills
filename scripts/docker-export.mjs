#!/usr/bin/env node
// Builds the Docker image (the same Dockerfile.vercel Vercel runs) and packs it with what the client
// needs to run it against their own MariaDB:
//
//   release/hc-waybill-docker/                 the folder to send (or the archive below)
//     hc-waybill-image.tar.gz                  the image: docker load -i hc-waybill-image.tar.gz
//     docker-compose.yml, hc-waybill.env.example, README.md   from docker/client/
//   release/hc-waybill-docker-v<version>.tar.gz   that folder as one file
//
//   npm run docker:export                      (linux/amd64, for ordinary PCs and servers)
//   npm run docker:export -- --arm             (linux/arm64, e.g. an Apple Silicon Mac)
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const root = join(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const platform = process.argv.includes('--arm') ? 'linux/arm64' : 'linux/amd64'
const IMAGE = 'hc-waybill'
const outDir = join(root, 'release', 'hc-waybill-docker')
const archive = join(root, 'release', `hc-waybill-docker-v${version}.tar.gz`)

function run(cmd, args, cwd = root) {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.error || r.status !== 0) process.exit(r.status ?? 1)
}

run('docker', ['build', '--platform', platform, '-f', 'Dockerfile.vercel', '-t', `${IMAGE}:${version}`, '-t', `${IMAGE}:latest`, '.'])

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
for (const f of readdirSync(join(root, 'docker', 'client'))) copyFileSync(join(root, 'docker', 'client', f), join(outDir, f))

// docker save | gzip, without needing gzip installed (Windows).
const image = join(outDir, 'hc-waybill-image.tar.gz')
console.log(`\n> docker save ${IMAGE}:${version} ${IMAGE}:latest | gzip > ${image}`)
const save = spawn('docker', ['save', `${IMAGE}:${version}`, `${IMAGE}:latest`], { stdio: ['ignore', 'pipe', 'inherit'] })
const saved = new Promise((ok, fail) => save.on('close', (code) => (code === 0 ? ok() : fail(new Error(`docker save exited with ${code}`)))))
await Promise.all([pipeline(save.stdout, createGzip(), createWriteStream(image)), saved])

run('tar', ['-czf', archive, '-C', join(root, 'release'), 'hc-waybill-docker'])

const mb = (f) => `${(statSync(f).size / 1e6).toFixed(0)} MB`
console.log(`\nDone (${platform}, v${version}):`)
console.log(`  ${outDir}  (image ${mb(image)})`)
console.log(`  ${archive}  (${mb(archive)}): send this one file to the client`)
