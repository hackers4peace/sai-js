import { proxyActivities } from '@temporalio/workflow'

import type * as activities from '../activities/webhook-delivery.js'

const { postWebhook } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 10,
  },
})

/**
 * Delivers one webhook notification. Network and 5xx failures retry; permanent
 * 4xx responses stop immediately.
 */
export async function deliverWebhook(payload: activities.PostWebhookInput): Promise<void> {
  await postWebhook(payload)
}
