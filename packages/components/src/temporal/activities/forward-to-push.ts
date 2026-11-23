import * as webpush from 'web-push'
import type { SendResult } from 'web-push'

webpush.setVapidDetails(
  process.env.CSS_PUSH_SENDER,
  process.env.CSS_VAPID_PUBLIC_KEY,
  process.env.CSS_VAPID_PRIVATE_KEY
)
export async function forwardToPush(subscription: any, payload: any): Promise<SendResult> {
  return webpush.sendNotification(subscription, JSON.stringify(payload))
}
