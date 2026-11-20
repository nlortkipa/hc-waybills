import type { SmsDelivery, SmsSettings } from '../types.ts'

/** Settings for a fresh install: no balance read yet (the account is in .env). */
export const defaultSmsSettings = (): SmsSettings => ({ sender: '' })

/** Delivery statuses that won't change any more: no need to ask smsoffice.ge again. */
export const SMS_FINAL: readonly SmsDelivery[] = ['Delivered', 'Undelivered', 'Expired']

/** Label and badge tone of an SMS delivery status. */
export const SMS_DELIVERY: Record<SmsDelivery, { label: string; tone: 'green' | 'red' | 'blue' | 'gray' }> = {
  Delivered: { label: 'მიწოდებულია', tone: 'green' },
  Pending: { label: 'იგზავნება', tone: 'blue' },
  Undelivered: { label: 'ვერ მიწოდდა', tone: 'red' },
  Expired: { label: 'ვადა გაუვიდა', tone: 'red' },
  Unknown: { label: 'გაგზავნილია', tone: 'green' },
}
