import { proxyActivities } from '@temporalio/workflow'

import type * as activities from '../activities/forward-to-push'

const { forwardToPush } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
})

export async function sendPushNotifications(
  subscriptions: Array<any>,
  payload: any
): Promise<void> {
  await Promise.all(subscriptions.map((subscription) => forwardToPush(subscription, payload)))
}
