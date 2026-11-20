/**
 * Hands a generated file to the user. In a browser that is a normal download; the Android app's
 * WebView can't download blobs, so there the app's bridge (MainActivity → window.HCNative) writes it
 * to Downloads and opens it.
 */
interface HCNativeBridge {
  saveFile?: (name: string, mime: string, base64: string) => string
  /** Asks Android for the next SMS (SMS User Consent); its code arrives as a `hc-otp` window event. */
  listenForSmsCode?: () => void
}
declare global {
  interface Window {
    HCNative?: HCNativeBridge
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Saves the file. Resolves to an error message when the app couldn't save it, else null. */
export async function saveFile(name: string, mime: string, bytes: Uint8Array): Promise<string | null> {
  const native = window.HCNative
  if (native?.saveFile) {
    const err = native.saveFile(name, mime, toBase64(bytes))
    return err || null
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return null
}
