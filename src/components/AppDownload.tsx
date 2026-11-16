import { Capacitor } from '@capacitor/core'
import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cx } from '../lib/util'

/** Built by `npm run android:apk` and served next to index.html (see vite.config.ts). */
const APK_URL = './hc-portal.apk'

/** Offered on phones and tablets in a browser — not on desktop, and not inside the app itself. */
const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent))
const canInstall = !Capacitor.isNativePlatform() && isMobile

let available: Promise<boolean> | null = null
function apkAvailable(): Promise<boolean> {
  available ??= fetch(APK_URL, { method: 'HEAD', cache: 'no-store' })
    .then((r) => r.ok && !(r.headers.get('content-type') ?? '').includes('text/html'))
    .catch(() => false)
  return available
}

/** True on a mobile browser when the server actually has an APK to hand out. */
function useApkDownload(): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    if (!canInstall) return
    let alive = true
    void apkAvailable().then((v) => alive && setOk(v))
    return () => {
      alive = false
    }
  }, [])
  return ok
}

export function AppDownloadButton({ className }: { className?: string }) {
  const show = useApkDownload()
  if (!show) return null
  return (
    <a
      href={APK_URL}
      download="hc-portal.apk"
      className={cx('pressable flex items-center gap-3 rounded-xl bg-surface p-3.5 text-left shadow-[0_1px_3px_rgba(0,0,0,0.06)] active:bg-slate-500/15', className)}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-emerald-500 text-white">
        <Download className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-slate-900">ჩამოტვირთე აპლიკაცია</span>
        <span className="block text-[13px] text-slate-500">მხოლოდ Android-ისთვის · APK ფაილი</span>
      </span>
    </a>
  )
}
